/* ============================================================================
 * crash-ui.js — Crash channel controller (on-chain, MetaMask only).
 *
 * The bet is settled in one Sepolia transaction via the contract's playCrash
 * (auto-cashout target, provably fair). The rocket animation is the REVEAL: the
 * crash point comes back from chain, the rocket flies up to it, cashing out at
 * your target if it got there. No play money.
 *
 * window.CrashGame.config({ getBalanceUsd, usd, toast, ready, playCrash });
 *   playCrash(stakeUsd, targetX) -> Promise<{crashX, won, targetX, betUsd, payoutUsd} | null>
 * ==========================================================================*/
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);

  let cfg = {
    getBalanceUsd: () => 0,
    usd: (n) => "$" + Math.round(n).toLocaleString(),
    toast: () => {},
    ready: () => false,
    playCrash: null,
    probeSupport: null, // () => Promise<bool|null> — does the live contract have Crash?
  };
  let mounted = false, busy = false, round = null, unsupported = false;

  function E() { return { mult: $("crash-mult"), sub: $("crash-sub"), bal: $("crash-bal"), launch: $("crash-launch") }; }
  function stakeVal() { return Math.max(0, +$("crash-stake").value || 0); }
  function targetVal() { return Math.max(1.01, +$("crash-target").value || 1.01); }
  function balanceUsd() { return Math.max(0, +cfg.getBalanceUsd() || 0); }

  function refresh() {
    const e = E(); if (!e.bal) return;
    e.bal.textContent = "BALANCE " + cfg.usd(balanceUsd());
    if (busy) return;
    if (unsupported) {
      e.launch.textContent = "🚀 NEEDS CONTRACT UPGRADE";
      e.launch.disabled = true;
      return;
    }
    e.launch.textContent = "🚀 LAUNCH · win " + cfg.usd(stakeVal() * (targetVal() - 1));
    e.launch.disabled = stakeVal() <= 0;
  }

  function pillClass(x) { return x < 2 ? "lo" : x < 5 ? "mid" : x < 20 ? "hi" : "mega"; }
  function addHistory(x) {
    const hist = $("crash-history"); if (!hist) return;
    const p = document.createElement("div");
    p.className = "ch-pill " + pillClass(x);
    p.textContent = x.toFixed(2) + "x";
    hist.insertBefore(p, hist.firstChild);
    while (hist.children.length > 16) hist.removeChild(hist.lastChild);
  }

  // The reveal animation: rise to the on-chain crash point at a snappy, bounded
  // pace. On a win, cash out at the target and finish quickly (fly off) instead
  // of dragging all the way up to a possibly-huge crash point.
  function tick() {
    if (!round || round.done) return;
    const e = E();
    const now = performance.now();
    if (round.cashed) {
      // brief fly-off after cashing out, then finish
      CrashRender.setMult(Math.min(round.crashX, CrashEngine.multiplierAtMs(now - round.t0, round.k)));
      if (now - round.cashAt >= 1000) endRound();
      return;
    }
    const mult = CrashEngine.multiplierAtMs(now - round.t0, round.k);
    if (round.won && mult >= round.targetX) {
      round.cashed = true; round.cashAt = now;
      CrashRender.cashout();
      CrashRender.setMult(round.targetX);
      e.mult.className = "win"; e.mult.textContent = round.targetX.toFixed(2) + "x";
      e.sub.textContent = "CASHED " + round.targetX.toFixed(2) + "x · +" + cfg.usd(round.payoutUsd - round.betUsd);
      return;
    }
    if (mult >= round.crashX) {
      CrashRender.setMult(round.crashX);
      CrashRender.setState("crashed");
      CrashRender.explode();
      endRound();
      return;
    }
    CrashRender.setMult(mult);
    e.mult.className = ""; e.mult.textContent = mult.toFixed(2) + "x";
  }

  function endRound() {
    const e = E();
    round.done = true;
    addHistory(round.crashX);
    if (round.won) {
      e.mult.className = "win"; e.mult.textContent = round.targetX.toFixed(2) + "x";
      cfg.toast("Cashed out " + round.targetX.toFixed(2) + "x · +" + cfg.usd(round.payoutUsd - round.betUsd), "ok");
    } else {
      e.mult.className = "bust"; e.mult.textContent = "CRASH " + round.crashX.toFixed(2) + "x";
      e.sub.textContent = "Busted at " + round.crashX.toFixed(2) + "x — −" + cfg.usd(round.betUsd);
    }
    busy = false; refresh();
    setTimeout(() => {
      if (round && round.done) {
        CrashRender.reset();
        const panel = $("crash-panel"); if (panel) panel.classList.remove("is-flight");
        e.mult.className = ""; e.mult.textContent = "1.00x";
        e.sub.textContent = "Set a cash-out target and launch 🚀";
        refresh();
      }
    }, 2600);
  }

  function reveal(res) {
    // bounded climb: ~1.6s base + grows mildly with the crash point, capped ~6s,
    // so even a 100x crash resolves quickly instead of rising forever.
    const lx = Math.log(Math.max(1.01, res.crashX));
    const revealMs = Math.max(1600, Math.min(6000, 1600 + 1200 * lx));
    const k = lx / revealMs;
    round = { crashX: res.crashX, targetX: res.targetX, won: res.won, betUsd: res.betUsd, payoutUsd: res.payoutUsd, t0: performance.now(), cashAt: 0, k, cashed: false, done: false };
    const e = E();
    const panel = $("crash-panel"); if (panel) panel.classList.add("is-flight"); // collapse the bet sheet so the scene is clear
    CrashRender.reset(); CrashRender.setState("flying"); CrashRender.setMult(1);
    e.mult.className = ""; e.mult.textContent = "1.00x"; e.sub.textContent = "🚀 to the moon…";
  }

  async function launch() {
    if (busy) return;
    if (unsupported) return cfg.toast("Crash needs a contract upgrade — redeploy the house contract to enable it.", "err");
    const stake = stakeVal(), target = targetVal();
    if (!(stake > 0)) return cfg.toast("Enter a stake", "err");
    if (typeof cfg.playCrash !== "function") return cfg.toast("Crash isn't wired up yet.", "err");
    busy = true;
    const e = E();
    e.launch.disabled = true; e.launch.textContent = "🚀 CONFIRM IN WALLET…";
    e.sub.textContent = "Confirm in your wallet…";
    let res;
    try { res = await cfg.playCrash(stake, target); }
    catch (err) { res = null; }
    if (!res) { busy = false; refresh(); E().sub.textContent = "Set a cash-out target and launch 🚀"; return; }
    e.launch.textContent = "🚀 IN FLIGHT…";
    reveal(res);
  }

  function wire() {
    $("crash-launch").onclick = launch;
    $("crash-stake").oninput = refresh;
    $("crash-target").oninput = refresh;
    document.querySelectorAll("#crash-panel [data-target]").forEach((b) => b.onclick = () => { $("crash-target").value = b.dataset.target; refresh(); });
    document.querySelectorAll("#crash-panel [data-stake]").forEach((b) => b.onclick = () => {
      const s = stakeVal(), bal = balanceUsd();
      $("crash-stake").value = b.dataset.stake === "half" ? Math.max(1, Math.floor(s / 2)) : b.dataset.stake === "double" ? Math.max(1, s * 2) : Math.max(1, Math.floor(bal));
      refresh();
    });
  }

  function mount() {
    if (mounted) return;
    mounted = true;
    CrashRender.init($("crash-canvas"));
    CrashRender.onFrame(tick);
    wire();
  }

  window.CrashGame = {
    config(c) { cfg = Object.assign(cfg, c || {}); },
    show() {
      const v = $("crash-view"); if (v) v.hidden = false;
      mount(); refresh();
      // If the live contract predates Crash, say so clearly and disable LAUNCH.
      if (cfg.probeSupport) {
        Promise.resolve(cfg.probeSupport()).then((s) => {
          unsupported = (s === false);
          if (unsupported) {
            const e = E();
            if (e.sub) e.sub.textContent = "⚠️ Crash needs a contract upgrade — redeploy the house contract to enable it.";
          }
          refresh();
        }).catch(() => {});
      }
    },
    hide() { const v = $("crash-view"); if (v) v.hidden = true; },
    refreshBalance() { refresh(); },
  };
})();
