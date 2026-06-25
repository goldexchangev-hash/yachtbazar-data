/* ============================================================================
 * crash-ui.js — Crash channel controller.
 *
 * Wires the #crash-view shell to the provably-fair engine (CrashEngine) and the
 * canvas renderer (CrashRender). Phase 1 plays out CLIENT-SIDE against a local
 * balance seeded from your in-game balance (like poker) — on-chain auto-cashout
 * settlement lands with the contract function + redeploy.
 *
 * window.CrashGame.config({ getBalanceUsd, usd, toast }); .show(); .hide();
 * ==========================================================================*/
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const EDGE = 0.01, K = (window.CrashEngine && CrashEngine.DEFAULT_K) || 0.0001;

  let cfg = {
    getBalanceUsd: () => 0,
    usd: (n) => "$" + Math.round(n).toLocaleString(),
    toast: () => {},
  };
  let mounted = false, balance = 0, round = null;

  function el() { return { mult: $("crash-mult"), sub: $("crash-sub"), bal: $("crash-bal"), hist: $("crash-history"), launch: $("crash-launch"), stake: $("crash-stake"), target: $("crash-target") }; }
  function stakeVal() { return Math.max(0, +$("crash-stake").value || 0); }
  function targetVal() { return Math.max(1.01, +$("crash-target").value || 1.01); }

  function refresh() {
    const e = el(); if (!e.bal) return;
    e.bal.textContent = "BALANCE " + cfg.usd(balance);
    const inFlight = round && !round.done;
    const profit = stakeVal() * (targetVal() - 1);
    e.launch.textContent = inFlight ? "🚀 IN FLIGHT…" : "🚀 LAUNCH · win " + cfg.usd(profit);
    e.launch.disabled = !!inFlight || stakeVal() <= 0 || stakeVal() > balance;
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

  function tick() {
    if (!round || round.done) return;
    const e = el();
    const ms = performance.now() - round.t0;
    let mult = CrashEngine.multiplierAtMs(ms, K);
    if (mult >= round.crashX) {
      CrashRender.setMult(round.crashX);
      CrashRender.setState("crashed");
      CrashRender.explode();
      endRound();
      return;
    }
    if (!round.cashed && mult >= round.targetX) {
      round.cashed = true;
      balance += round.stake * round.targetX; // pay stake*target (stake escrowed at launch)
      CrashRender.cashout();
      e.mult.className = "win";
      e.sub.textContent = "CASHED " + round.targetX.toFixed(2) + "x · +" + cfg.usd(round.stake * (round.targetX - 1));
      refresh();
    }
    CrashRender.setMult(mult);
    if (!round.cashed) e.mult.className = "";
    e.mult.textContent = mult.toFixed(2) + "x";
  }

  function endRound() {
    const e = el();
    round.done = true;
    addHistory(round.crashX);
    if (round.cashed) {
      e.mult.className = "win"; e.mult.textContent = round.targetX.toFixed(2) + "x";
    } else {
      e.mult.className = "bust"; e.mult.textContent = "CRASH " + round.crashX.toFixed(2) + "x";
      e.sub.textContent = "Busted — −" + cfg.usd(round.stake);
      cfg.toast("Crashed at " + round.crashX.toFixed(2) + "x — −" + cfg.usd(round.stake), "err");
    }
    refresh();
    setTimeout(() => {
      if (round && round.done) {
        CrashRender.reset();
        e.mult.className = ""; e.mult.textContent = "1.00x";
        e.sub.textContent = "Set a cash-out target and launch 🚀";
        refresh();
      }
    }, 2600);
  }

  function launch() {
    if (round && !round.done) return;
    const stake = stakeVal();
    if (!(stake > 0)) return cfg.toast("Enter a stake", "err");
    if (stake > balance) return cfg.toast("Not enough balance for that stake", "err");
    const e = el();
    balance -= stake; // escrow
    round = { crashX: CrashEngine.crashFromRandom(Math.random, EDGE), targetX: targetVal(), stake, t0: performance.now(), cashed: false, done: false };
    CrashRender.reset();
    CrashRender.setState("flying");
    CrashRender.setMult(1);
    e.mult.className = ""; e.mult.textContent = "1.00x"; e.sub.textContent = "🚀 to the moon…";
    refresh();
  }

  function wire() {
    $("crash-launch").onclick = launch;
    $("crash-stake").oninput = refresh;
    $("crash-target").oninput = refresh;
    document.querySelectorAll("#crash-panel [data-target]").forEach((b) => b.onclick = () => { $("crash-target").value = b.dataset.target; refresh(); });
    document.querySelectorAll("#crash-panel [data-stake]").forEach((b) => b.onclick = () => {
      const s = stakeVal();
      $("crash-stake").value = b.dataset.stake === "half" ? Math.max(1, Math.floor(s / 2)) : b.dataset.stake === "double" ? Math.min(balance, Math.max(1, s * 2)) : Math.max(1, Math.floor(balance));
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
      mount();
      // Seed the play-money balance from the real in-game balance each entry;
      // fall back to a demo bankroll so the scene is always playable to look at.
      balance = Math.max(0, +cfg.getBalanceUsd() || 0);
      if (balance < 1) balance = 500;
      refresh();
    },
    hide() { const v = $("crash-view"); if (v) v.hidden = true; },
  };
})();
