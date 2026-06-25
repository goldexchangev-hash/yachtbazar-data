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
  };
  let mounted = false, busy = false, round = null;

  function E() { return { mult: $("crash-mult"), sub: $("crash-sub"), bal: $("crash-bal"), launch: $("crash-launch") }; }
  function stakeVal() { return Math.max(0, +$("crash-stake").value || 0); }
  function targetVal() { return Math.max(1.01, +$("crash-target").value || 1.01); }
  function balanceUsd() { return Math.max(0, +cfg.getBalanceUsd() || 0); }

  function refresh() {
    const e = E(); if (!e.bal) return;
    e.bal.textContent = "BALANCE " + cfg.usd(balanceUsd());
    if (busy) return;
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

  // The reveal animation: rise to the on-chain crash point at a snappy, value-
  // scaled pace, cashing out at the target on the way if we got there.
  function tick() {
    if (!round || round.done) return;
    const e = E();
    const ms = performance.now() - round.t0;
    let mult = CrashEngine.multiplierAtMs(ms, round.k);
    if (mult >= round.crashX) {
      CrashRender.setMult(round.crashX);
      CrashRender.setState("crashed");
      CrashRender.explode();
      endRound();
      return;
    }
    if (!round.cashed && mult >= round.targetX) {
      round.cashed = true;
      CrashRender.cashout();
      e.mult.className = "win";
      e.sub.textContent = "CASHED " + round.targetX.toFixed(2) + "x · +" + cfg.usd(round.payoutUsd - round.betUsd);
    }
    CrashRender.setMult(mult);
    if (!round.cashed) e.mult.className = "";
    e.mult.textContent = mult.toFixed(2) + "x";
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
        e.mult.className = ""; e.mult.textContent = "1.00x";
        e.sub.textContent = "Set a cash-out target and launch 🚀";
        refresh();
      }
    }, 2800);
  }

  function reveal(res) {
    // pace the climb: ~1.8s base + grows mildly with the multiplier, capped ~9s
    const revealMs = Math.max(1800, Math.min(9000, 1800 + 1400 * Math.log(Math.max(1.01, res.crashX))));
    const k = Math.log(Math.max(1.01, res.crashX)) / revealMs;
    round = { crashX: res.crashX, targetX: res.targetX, won: res.won, betUsd: res.betUsd, payoutUsd: res.payoutUsd, t0: performance.now(), k, cashed: false, done: false };
    const e = E();
    CrashRender.reset(); CrashRender.setState("flying"); CrashRender.setMult(1);
    e.mult.className = ""; e.mult.textContent = "1.00x"; e.sub.textContent = "🚀 to the moon…";
  }

  async function launch() {
    if (busy) return;
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
    show() { const v = $("crash-view"); if (v) v.hidden = false; mount(); refresh(); },
    hide() { const v = $("crash-view"); if (v) v.hidden = true; },
    refreshBalance() { refresh(); },
  };
})();
