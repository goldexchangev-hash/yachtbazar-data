/* ============================================================
   plane-ui.js — "PLANE v2 (JETLINE)": continuous round loop + DUAL live
   cash-out bets. Snappier pacing (betting 4s + 0.7s takeoff + 1.6s crash pause).
   Two independent side-by-side bets (A safe / B risky) ride ONE crash point and
   ONE nonce; each has its own auto-cashout + big button. Money lives only in
   PlaneEngine; the renderer + feed are cosmetic. Frame rate can't affect money.
   new PlaneGame({ mount, els, panels:[elsA, elsB], width, height })
   ============================================================ */
(function (root) {
  "use strict";
  const E = root.PlaneEngine;
  const ETH_USD = 3400, MIN_BET = 10, MAX_AUTO = 999.99;
  const BET_WINDOW = 4.0, TAKEOFF_BEAT = 0.7, CRASH_PAUSE = 1.6;

  /* Self-contained rising "engine" tone (own AudioContext; never touches the
     shared chiptune.js). Pitch/cutoff/gain ramp with the live multiplier. */
  const Riser = (function () {
    let ctx, osc, osc2, lp, gain, on = false, muted = true;
    function ensure() {
      if (ctx) return; const AC = root.AudioContext || root.webkitAudioContext; if (!AC) return;
      ctx = new AC(); gain = ctx.createGain(); gain.gain.value = 0;
      lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 320;
      gain.connect(ctx.destination); lp.connect(gain);
      osc = ctx.createOscillator(); osc.type = "sawtooth"; osc.frequency.value = 70; osc.connect(lp); osc.start();
      osc2 = ctx.createOscillator(); osc2.type = "sawtooth"; osc2.frequency.value = 71; osc2.connect(lp); osc2.start();
    }
    return {
      start() { ensure(); if (!ctx) return; if (ctx.state === "suspended") ctx.resume(); on = true; gain.gain.setTargetAtTime(muted ? 0 : 0.05, ctx.currentTime, 0.05); },
      set(m) { if (!ctx || !on) return; const f = 60 + Math.min(360, Math.log(Math.max(1, m)) * 72); osc.frequency.setTargetAtTime(f, ctx.currentTime, 0.08); osc2.frequency.setTargetAtTime(f * 1.02, ctx.currentTime, 0.08); lp.frequency.setTargetAtTime(320 + Math.min(2600, m * 32), ctx.currentTime, 0.1); gain.gain.setTargetAtTime(muted ? 0 : Math.min(0.12, 0.04 + Math.log(Math.max(1, m)) * 0.013), ctx.currentTime, 0.1); },
      stop() { if (!ctx) return; on = false; gain.gain.setTargetAtTime(0, ctx.currentTime, 0.06); },
      mute(b) { muted = b; if (ctx && muted) gain.gain.setTargetAtTime(0, ctx.currentTime, 0.02); },
    };
  })();

  function PlaneGame(opts) {
    this.els = opts.els || {};
    this.houseEdge = opts.houseEdge != null ? opts.houseEdge : 0.03; this.cap = 1000;
    this.serverSeed = E.randomSeed(24);
    this.clientSeed = (this.els.pfClient && this.els.pfClient.value) || E.randomSeed(8);
    this.nonce = 0; this.commitHash = E.commit(this.serverSeed);

    // ── Bridge into the host app (mirrors PressureGame) ────────────────────────
    // Money lives in the host. In DEMO the host's play-money (demoUsd) is the
    // source of truth — we mutate this.balance and push it back via onBalance.
    // In REAL the host owns the on-chain balance; this.balance is display-only and
    // each launch is a single on-chain tx (onRealBet) — no live tap-to-cashout.
    this.mode = opts.mode || "demo";        // "demo" | "real"
    this.ethUsd = opts.ethUsd || 3400;
    this.onBalance = opts.onBalance || null; // (usd) → sync demo play-money
    this.onWin = opts.onWin || null;         // ({profitUsd,mult}) → share-win card
    this.onRealBet = opts.onRealBet || null; // (betUsd,targetX100) → Promise<result|null>
    this.onRealDone = opts.onRealDone || null; // () → host refreshes balance after the flight
    this.balance = opts.initialBalance != null ? opts.initialBalance : 5000;
    this._active = false; this._enabled = (this.mode === "demo");
    this._realBusy = false; this._realRes = null;

    const mk = (id, defStake, defAuto, autoOn, els) => ({ id, stake: defStake, baseStake: defStake, betPlaced: false, active: false, cashed: false, autoOn, autoTarget: defAuto, autoBet: false, martingale: false, _cashedAt: 0, els: els || {} });
    this.muted = true;
    const panels = opts.panels || [{}, {}];
    this.bets = [mk("A", MIN_BET, 1.5, true, panels[0]), mk("B", MIN_BET, 10, true, panels[1])];

    this.state = "betting"; this.countdown = BET_WINDOW; this.flightT = 0; this.crash = 0; this._pause = 0;
    this.history = []; this._miles = {};

    this.r = new root.PlaneRenderer({ mount: opts.mount, width: opts.width || 660, height: opts.height || 412, onTick: (dt) => this._tick(dt) });
    if (root.PlaneFeed && this.els.feed) root.PlaneFeed.mount(this.els.feed);

    this._wire();
    this._renderHud(); this.bets.forEach((b) => this._syncPanel(b));
    if (this.mode === "real") this._startRealIdle(); else this._startBetting();
  }

  /* ---------- helpers ---------- */
  PlaneGame.prototype._save = function () { if (this.mode === "demo" && this.onBalance) { try { this.onBalance(this.balance); } catch (e) {} } };
  PlaneGame.prototype._fmt = function (n) { return (Math.round(n * 100) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  PlaneGame.prototype._usd = function (n) { return "$" + this._fmt(n); };
  PlaneGame.prototype._eth = function (n) { return "Ξ" + (n / (this.ethUsd || 3400)).toFixed(4); };
  PlaneGame.prototype._msg = function (t, cls) { if (this.els.message) { this.els.message.textContent = t; this.els.message.className = "plane-msg " + (cls || ""); } };
  PlaneGame.prototype._sfx = function (m) { try { if (root.Chiptune && Chiptune[m]) Chiptune[m](); } catch (e) {} };

  PlaneGame.prototype._renderHud = function () {
    const e = this.els;
    if (e.balance) e.balance.textContent = this._usd(this.balance);
    if (e.balanceEth) e.balanceEth.textContent = "≈ " + this._eth(this.balance);
    if (e.pfHash) e.pfHash.textContent = this.commitHash.slice(0, 16) + "…";
    if (e.pfNonce) e.pfNonce.textContent = String(this.nonce);
  };
  PlaneGame.prototype._syncPanel = function (b) {
    const e = b.els;
    if (e.betInput) e.betInput.value = b.stake;
    if (e.betVal) e.betVal.textContent = this._usd(b.stake);
    if (e.betEth) e.betEth.textContent = "≈ " + this._eth(b.stake);
    if (e.autoSlider) e.autoSlider.value = b.autoTarget;
    if (e.autoVal) e.autoVal.textContent = b.autoTarget.toFixed(2) + "x";
    if (e.autoToggle) { e.autoToggle.classList.toggle("active", b.autoOn); e.autoToggle.textContent = b.autoOn ? "AUTO ✓" : "AUTO"; }
    if (e.autobet) { e.autobet.classList.toggle("active", b.autoBet); e.autobet.textContent = b.autoBet ? "⟳ AUTOBET ✓" : "⟳ AUTOBET"; }
    if (e.mart) e.mart.classList.toggle("active", b.martingale);
  };

  /* ---------- round loop ---------- */
  PlaneGame.prototype._startBetting = function () {
    this.state = "betting"; this.countdown = BET_WINDOW; this.flightT = 0; this._miles = {};
    this.bets.forEach((b) => {
      b.cashed = false; b.active = false; b._cashedAt = 0;
      if (b.autoBet) { if (this.balance >= b.stake) b.betPlaced = true; else b.autoBet = false; this._syncPanel(b); }   // auto-bet re-arms
      if (b.betPlaced && this.balance < b.stake) b.betPlaced = false;
    });
    this.r.setCountdown(this.countdown, BET_WINDOW);
    this._msg("Place your bets — plane departs soon", "");
    this._renderButtons();
  };
  PlaneGame.prototype._enterTakeoff = function () { this.state = "takeoff"; this.r.takeoff(); this._msg("Taking off…", ""); this._renderButtons(); };

  PlaneGame.prototype._startFlight = function () {
    this.nonce += 1; this.crash = E.deriveCrash(this.serverSeed, this.clientSeed, this.nonce, this.houseEdge, this.cap);
    this.flightT = 0; this._miles = {};
    let any = false;
    this.bets.forEach((b) => { b.cashed = false; if (b.betPlaced && this.balance >= b.stake) { this.balance = Math.round((this.balance - b.stake) * 100) / 100; b.active = true; any = true; } else b.active = false; });
    this._save(); this.state = "flying"; this.r.flying(); Riser.start();
    this.r.setTargets(this.bets.filter((b) => b.active && b.autoOn).map((b) => ({ mult: b.autoTarget, color: b.id === "A" ? 0x39e7ff : 0xff4d9d })));
    if (root.PlaneFeed) root.PlaneFeed.start(this.nonce, this.crash, this.bets.filter((b) => b.active).map((b) => ({ stake: b.stake, target: b.autoOn ? b.autoTarget : 99, manual: !b.autoOn })));
    this._renderHud(); this._renderButtons(); this._sfx("blip");
  };

  PlaneGame.prototype._tick = function (dt) {
    // ── REAL (single-shot) flight: crash point is fixed by the on-chain tx ──────
    if (this.state === "real-flying") {
      this.flightT += dt;
      const m = E.multiplierAtTime(this.flightT), res = this._realRes;
      this.r.setLive(m); Riser.set(m);
      [10, 50, 100].forEach((n) => { if (m >= n && !this._miles[n]) { this._miles[n] = 1; this.r.milestone(n); this._sfx("coin"); } });
      if (res.won && m >= res.targetX) { this._realCashOut(); return; }
      if (m >= res.crashX) { this._realCrash(); return; }
      return;
    } else if (this.state === "real-end") {
      this._pause -= dt; if (this._pause <= 0) this._endRealRound();
      return;
    }
    if (this.mode !== "demo") return; // real mode idles between launches
    if (this.state === "betting") {
      this.countdown -= dt;
      if (this.countdown <= TAKEOFF_BEAT) { this._enterTakeoff(); return; }
      this.r.setCountdown(Math.max(0, this.countdown), BET_WINDOW); this._renderButtons();
    } else if (this.state === "takeoff") {
      this.countdown -= dt; if (this.countdown <= 0) this._startFlight();
    } else if (this.state === "flying") {
      this.flightT += dt;
      const m = E.multiplierAtTime(this.flightT);
      this.r.setLive(m); Riser.set(m);
      if (root.PlaneFeed) root.PlaneFeed.tick(m);
      [10, 50, 100].forEach((n) => { if (m >= n && !this._miles[n]) { this._miles[n] = 1; this.r.milestone(n); this._sfx("coin"); } });
      this.bets.forEach((b) => { if (b.active && !b.cashed && b.autoOn && m >= b.autoTarget) this._cashOut(b, b.autoTarget, true); });
      if (m >= this.crash) { this._doCrash(); return; }
      this._renderButtons(m);
    } else if (this.state === "crashed") {
      this._pause -= dt; if (this._pause <= 0) this._startBetting();
    }
  };

  PlaneGame.prototype._cashOut = function (b, mult, auto) {
    if (this.state !== "flying" || !b.active || b.cashed) return;
    // cashing out exactly AT the crash point is a WIN (matches PlaneEngine.resolveRound's
    // `co <= crash` and the on-chain `crashX >= target`); only a strictly higher cash-out loses.
    mult = Math.floor(mult * 100) / 100; if (mult > this.crash) return;
    b.cashed = true; b._cashedAt = mult;
    const res = E.resolveRound({ stake: b.stake, crash: this.crash, cashOutMult: mult });
    this.balance = Math.round((this.balance + res.payout) * 100) / 100; this._save();
    this.r.cashOut(res.profit, mult, b.stake);
    if (root.PlaneFeed && b.id === "A") root.PlaneFeed.setMine({ cashed: true, at: mult });
    this._msg("💰 " + b.id + " " + (auto ? "auto-" : "") + "cashed " + mult.toFixed(2) + "x  →  " + this._usd(res.payout) + "  (+" + this._usd(res.profit) + ")", "win");
    this._sfx("coin"); this._sfx(res.profit >= 300 ? "jackpot" : res.profit >= 100 ? "bigwin" : "win");
    if (this.onWin && res.profit > 0) { try { this.onWin({ profitUsd: res.profit, mult: mult }); } catch (e) {} }
    this._renderHud(); this._renderButtons(mult);
  };

  PlaneGame.prototype._doCrash = function () {
    this.state = "crashed"; this._pause = CRASH_PAUSE; Riser.stop();
    const instant = this.crash <= 1.01;
    this.r.crash(this.crash, instant);
    if (root.PlaneFeed) root.PlaneFeed.crash(this.crash);
    this.history.unshift(this.crash); this.history = this.history.slice(0, 20); this._renderHistory();
    let lost = 0, near = null;
    this.bets.forEach((b) => {
      if (b.active && !b.cashed) lost += b.stake;
      if (b.cashed && (this.crash - b._cashedAt) <= Math.max(0.05, this.crash * 0.06)) near = { at: b._cashedAt, crash: this.crash };
      if (b.active && b.autoBet && b.martingale) { b.stake = b.cashed ? b.baseStake : Math.max(MIN_BET, Math.min(this.balance, Math.round(b.stake * 2 * 100) / 100)); this._syncPanel(b); }
    });
    if (near) this.r.nearMiss(near.at, near.crash);
    if (lost > 0) { this._msg("✈️ Flew away @ " + this.crash.toFixed(2) + "x — lost " + this._usd(lost), "lose"); this._sfx("lose"); }
    else if (!this.bets.some((b) => b.cashed)) this._msg("Round flew @ " + this.crash.toFixed(2) + "x", "");
    this.lastRound = { nonce: this.nonce, crash: this.crash };
    this._updatePfLast(); this._renderButtons();
  };

  // The stake is editable only before a round commits (demo betting window, or
  // real-mode idle) — never once it's taking off / flying / settling.
  PlaneGame.prototype._canEditBet = function () {
    return this.state === "betting" || this.state === "real-idle";
  };

  /* ---------- buttons ---------- */
  PlaneGame.prototype._renderButton = function (b, live) {
    // lock/unlock the stake controls to match whether a bet can be changed
    const ed = b.els, canEdit = this._canEditBet();
    [ed.betInput, ed.betUp, ed.betDown, ed.betHalf, ed.betDouble, ed.betMax].forEach((el) => { if (el) el.disabled = !canEdit; });
    const btn = b.els.action; if (!btn) return;
    let txt = "", kind = "wait", dis = true;
    // REAL single-shot: only bet A launches one on-chain round at its auto target.
    if (this.mode === "real") {
      if (b.id !== "A") { btn.textContent = "DEMO ONLY"; btn.dataset.kind = "wait"; btn.disabled = true; return; }
      if (this._realBusy) { txt = this.state === "real-flying" ? "✈️ IN FLIGHT…" : "LAUNCHING…"; kind = "wait"; dis = true; }
      else if (!this._enabled) { txt = "CONNECT TO PLAY"; kind = "wait"; dis = true; }
      else { txt = "🚀 LAUNCH " + this._usd(b.stake) + " @ " + b.autoTarget.toFixed(2) + "x"; kind = "bet"; dis = this.balance < b.stake; }
      btn.textContent = txt; btn.dataset.kind = kind; btn.disabled = dis; return;
    }
    if (this.state === "betting") {
      if (b.betPlaced) { txt = "✓ BET " + this._usd(b.stake) + " · cancel"; kind = "cancel"; dis = false; }
      else { txt = "BET " + b.id + " " + this._usd(b.stake); kind = "bet"; dis = this.balance < b.stake; }
    } else if (this.state === "takeoff") { txt = b.betPlaced ? "TAKING OFF…" : "BET NEXT"; kind = "wait"; dis = true; }
    else if (this.state === "flying") {
      if (b.active && !b.cashed) {
        if (b.autoOn) { txt = "AUTO @ " + b.autoTarget.toFixed(2) + "x"; kind = "auto"; dis = true; }
        else { txt = "CASH OUT " + this._usd(b.stake * (live || this.r.getRenderedMultiplier() || 1)); kind = "cashout"; dis = false; }
      } else if (b.cashed) { txt = "✓ CASHED OUT"; kind = "done"; dis = true; }
      else { txt = b.betPlaced ? "WAITING…" : "BET NEXT"; kind = "wait"; dis = true; }
    } else { txt = "ROUND OVER"; kind = "wait"; dis = true; }
    btn.textContent = txt; btn.dataset.kind = kind; btn.disabled = dis;
  };
  PlaneGame.prototype._renderButtons = function (m) { this.bets.forEach((b) => this._renderButton(b, m)); };

  PlaneGame.prototype._onAction = function (b) {
    if (this.mode === "real") { if (b.id === "A") this._realLaunch(); return; }
    if (this.state === "betting") {
      if (b.betPlaced) { b.betPlaced = false; }
      else if (this.balance >= b.stake) { b.betPlaced = true; }
      else { this._msg("Not enough balance", "lose"); }
      this._renderButtons();
    } else if (this.state === "flying" && b.active && !b.cashed && !b.autoOn) {
      this._cashOut(b, this.r.getRenderedMultiplier(), false);
    }
  };

  /* ---------- REAL (single-shot, one on-chain tx) ---------- */
  PlaneGame.prototype._startRealIdle = function () {
    this._realEpoch = (this._realEpoch || 0) + 1; // invalidate any older in-flight tx resolution
    this.state = "real-idle"; this._realBusy = false; this._realRes = null; this._miles = {};
    this.r.reset(); this.r.setCountdown(0, BET_WINDOW);
    this._msg("Set your bet + auto-cash-out, then LAUNCH for real", "");
    this._renderButtons();
  };
  PlaneGame.prototype._realLaunch = function () {
    if (this.mode !== "real" || this._realBusy || !this._active) return;
    if (!this._enabled) { this._msg("Connect a wallet to play for real", ""); return; }
    if (!this.onRealBet) return;
    const b = this.bets[0];
    const stake = b.stake, target = Math.max(1.01, Math.min(this.cap, b.autoTarget));
    if (this.balance < stake) { this._msg("Not enough balance — deposit first 👇", "lose"); return; }
    this._realBusy = true; this._miles = {};
    const epoch = this._realEpoch; // a mode switch / new idle bumps this → a stale resolve is dropped
    this._msg("Launching… confirm in your wallet ✈️", "");
    this.r.takeoff(); this._renderButtons();
    Promise.resolve(this.onRealBet(stake, Math.round(target * 100))).then((res) => {
      if (epoch !== this._realEpoch) return; // superseded (e.g. switched to demo mid-tx) — don't write back
      if (!res) { this._realBusy = false; this._startRealIdle(); return; }
      this._realRes = { won: !!res.won, crashX: res.crashX, targetX: res.targetX, profitUsd: res.profitUsd || 0, stake: stake };
      if (!this._active) {
        // Left the channel while the wallet tx was still pending. The round is
        // already settled on-chain, so finish it HEADLESSLY (no animation — the
        // ticker is paused) so _realBusy clears and the host's revealLock releases
        // immediately instead of hanging on the 20s safety timer.
        this.history.unshift(res.crashX); this.history = this.history.slice(0, 20); this._renderHistory();
        this.lastRound = { nonce: this.nonce, crash: res.crashX }; this._updatePfLast();
        this.state = "real-end"; this._endRealRound(); return;
      }
      this.crash = res.crashX; this.flightT = 0; this.state = "real-flying";
      this.r.flying(); Riser.start(); this._sfx("blip");
    }).catch(() => { if (epoch !== this._realEpoch) return; this._realBusy = false; this._startRealIdle(); });
  };
  PlaneGame.prototype._realCashOut = function () {
    const res = this._realRes;
    this.r.cashOut(res.profitUsd, res.targetX, res.stake);
    this._sfx("coin"); this._sfx(res.profitUsd >= 300 ? "jackpot" : res.profitUsd >= 100 ? "bigwin" : "win");
    this._msg("💰 Cashed " + res.targetX.toFixed(2) + "x  →  +" + this._usd(res.profitUsd) + " (real)", "win");
    if (this.onWin && res.profitUsd > 0) { try { this.onWin({ profitUsd: res.profitUsd, mult: res.targetX }); } catch (e) {} }
    this.history.unshift(res.crashX); this.history = this.history.slice(0, 20); this._renderHistory();
    this.lastRound = { nonce: this.nonce, crash: res.crashX }; this._updatePfLast();
    this.state = "real-end"; this._pause = CRASH_PAUSE; Riser.stop();
  };
  PlaneGame.prototype._realCrash = function () {
    const res = this._realRes;
    const instant = res.crashX <= 1.01; this.r.crash(res.crashX, instant);
    this._msg("✈️ Flew away @ " + res.crashX.toFixed(2) + "x — lost " + this._usd(res.stake), "lose"); this._sfx("lose");
    this.history.unshift(res.crashX); this.history = this.history.slice(0, 20); this._renderHistory();
    this.lastRound = { nonce: this.nonce, crash: res.crashX }; this._updatePfLast();
    this.state = "real-end"; this._pause = CRASH_PAUSE; Riser.stop();
  };
  PlaneGame.prototype._endRealRound = function () {
    this._realBusy = false;
    if (this.onRealDone) { try { this.onRealDone(); } catch (e) {} } // host refreshes balance
    this._startRealIdle();
  };

  /* ---------- wiring ---------- */
  PlaneGame.prototype._wire = function () {
    const e = this.els;
    document.addEventListener("keydown", (ev) => {
      if (ev.code !== "Space" || !this._active) return; // only the live Plane channel owns space
      const tag = (ev.target && ev.target.tagName) || "";
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      if (document.querySelector(".modal:not(.hidden)")) return; // a dialog is open
      ev.preventDefault();
      if (this.mode === "real") this._realLaunch(); else this._onAction(this.bets[0]);
    });
    if (e.addCredits) e.addCredits.addEventListener("click", () => { this.balance += 1000; this._save(); this._renderHud(); this._msg("+$1,000.00 added", ""); this._renderButtons(); });
    if (e.soundBtn) e.soundBtn.addEventListener("click", () => { this.muted = !this.muted; Riser.mute(this.muted); try { if (this.muted && Chiptune.stop) Chiptune.stop(); } catch (x) {} e.soundBtn.textContent = this.muted ? "🔇" : "🔊"; });
    if (e.pfClient) e.pfClient.addEventListener("change", () => { this.clientSeed = e.pfClient.value || E.randomSeed(8); });
    if (e.pfVerify) e.pfVerify.addEventListener("click", () => this._verifyLast());
    if (e.feedTabs) e.feedTabs.forEach((t) => t.addEventListener("click", () => { if (root.PlaneFeed) root.PlaneFeed.setTab(t.dataset.tab); e.feedTabs.forEach((x) => x.classList.toggle("active", x === t)); }));
    this.bets.forEach((b) => this._wirePanel(b));
  };
  PlaneGame.prototype._wirePanel = function (b) {
    const e = b.els;
    const step = (s) => (s < 100 ? 10 : s < 1000 ? 50 : 100);
    const setBet = (v) => {
      // Once a round has committed (taking off / in flight) the stake is LOCKED —
      // otherwise sliding it mid-flight would change the active payout (the demo
      // deducts at launch but cashes out on the current stake). Edit only while
      // betting / idle; the controls are also disabled in those states.
      if (!this._canEditBet()) { this._syncPanel(b); return; }
      b.stake = Math.max(MIN_BET, Math.round(v * 100) / 100); b.baseStake = b.stake; this._syncPanel(b); this._renderButtons();
    };
    if (e.action) e.action.addEventListener("click", () => this._onAction(b));
    if (e.betUp) e.betUp.addEventListener("click", () => setBet(b.stake + step(b.stake)));
    if (e.betDown) e.betDown.addEventListener("click", () => setBet(b.stake - step(b.stake - 0.01)));
    if (e.betHalf) e.betHalf.addEventListener("click", () => setBet(b.stake / 2));
    if (e.betDouble) e.betDouble.addEventListener("click", () => setBet(b.stake * 2));
    if (e.betMax) e.betMax.addEventListener("click", () => setBet(this.balance));
    if (e.betInput) { e.betInput.addEventListener("change", () => setBet(parseFloat(e.betInput.value) || MIN_BET)); e.betInput.addEventListener("input", () => setBet(parseFloat(e.betInput.value) || MIN_BET)); }
    const setAuto = (v) => { b.autoTarget = Math.max(1.01, Math.min(MAX_AUTO, Math.round(v * 100) / 100)); this._syncPanel(b); };
    if (e.autoSlider) e.autoSlider.addEventListener("input", () => setAuto(parseFloat(e.autoSlider.value)));
    if (e.autoToggle) e.autoToggle.addEventListener("click", () => { b.autoOn = !b.autoOn; this._syncPanel(b); this._renderButtons(); });
    if (e.autobet) e.autobet.addEventListener("click", () => { b.autoBet = !b.autoBet; if (b.autoBet) { b.baseStake = b.stake; if (this.state === "betting" && this.balance >= b.stake) b.betPlaced = true; } this._syncPanel(b); this._renderButtons(); });
    if (e.mart) e.mart.addEventListener("click", () => { b.martingale = !b.martingale; b.baseStake = b.stake; this._syncPanel(b); });
  };

  /* ---------- misc ---------- */
  PlaneGame.prototype._renderHistory = function () {
    if (!this.els.history) return;
    this.els.history.innerHTML = this.history.map((x) => { const c = x < 2 ? "lo" : x < 5 ? "mid" : x < 20 ? "hi" : "mega"; return '<span class="ph-pill ' + c + '">' + x.toFixed(2) + "x</span>"; }).join("");
  };
  PlaneGame.prototype._updatePfLast = function () { if (this.els.pfNonce) this.els.pfNonce.textContent = String(this.nonce); if (this.els.pfLast && this.lastRound) this.els.pfLast.textContent = "round #" + this.lastRound.nonce + " · crash " + this.lastRound.crash.toFixed(2) + "x"; };
  PlaneGame.prototype._verifyLast = function () {
    if (!this.lastRound) { this._msg("Wait for a round, then verify", ""); return; }
    if (this.mode === "real") { // real crashes come from the on-chain contract, not this client engine
      if (this.els.pfReveal) this.els.pfReveal.textContent = "Real mode: the crash point is decided on-chain — verify the result on the block explorer (this client seed verifies demo rounds).";
      this._msg("Real rounds settle on-chain — they're verifiable on the explorer", "");
      return;
    }
    const v = E.verify(this.serverSeed, this.commitHash, this.clientSeed, this.lastRound.nonce, this.houseEdge, this.cap);
    const ok = v.hashOk && Math.abs(v.crash - this.lastRound.crash) < 1e-9;
    if (this.els.pfReveal) this.els.pfReveal.textContent = "serverSeed " + this.serverSeed.slice(0, 12) + "… → hash " + (v.hashOk ? "MATCHES ✓" : "✗") + " · crash " + v.crash.toFixed(2) + "x (" + (ok ? "verified ✓" : "✗") + ")";
    this._msg(ok ? "✅ Round #" + this.lastRound.nonce + " verified" : "⚠️ mismatch", ok ? "win" : "lose");
  };

  /* ---------- host bridge API (mirrors PressureGame) ---------- */
  PlaneGame.prototype.setActive = function (on) {
    this._active = !!on;
    // Leaving the channel mid-REAL-flight would pause the Pixi ticker that drives
    // _tick → the outcome never resolves, _realBusy stays latched, and the host's
    // revealLock would hang for 20s. The on-chain round is ALREADY settled, so
    // resolve the animation now (skipping the pause) and let the host unlock.
    if (!on && this._realRes) {
      if (this.state === "real-flying") { if (this._realRes.won) this._realCashOut(); else this._realCrash(); this._endRealRound(); }
      else if (this.state === "real-end") { this._endRealRound(); }
    }
    try { if (on) this.r.resume(); else this.r.pause(); } catch (e) {}
    // Resume the climb audio if we're returning to a frozen-mid-flight round
    // (the ticker was paused on leave); silence it when leaving.
    if (on) { if (this.state === "flying" || this.state === "real-flying") { try { Riser.start(); } catch (e) {} } }
    else { try { Riser.stop(); } catch (e) {} }
  };
  PlaneGame.prototype.setEnabled = function (on) { this._enabled = !!on; this._renderButtons(); };
  // Drop any in-flight demo round and start a fresh betting window (used on credit reset).
  PlaneGame.prototype.restartDemo = function () {
    if (this.mode !== "demo") return;
    try { Riser.stop(); } catch (e) {}
    this.bets.forEach((b) => { b.betPlaced = false; b.active = false; b.cashed = false; this._syncPanel(b); });
    this._startBetting();
  };
  PlaneGame.prototype.setBalance = function (usd) {
    if (!(usd >= 0)) usd = 0;
    this.balance = Math.round(usd * 100) / 100;
    this._renderHud(); this._renderButtons();
  };
  PlaneGame.prototype.setEthUsd = function (n) { if (n > 0) { this.ethUsd = n; this._renderHud(); this.bets.forEach((b) => this._syncPanel(b)); } };
  PlaneGame.prototype.setMode = function (m) {
    if (m !== "real" && m !== "demo") return;
    if (m === this.mode) return;
    // If a DEMO round is mid-flight when we switch (e.g. wallet just connected),
    // its stake was already debited — refund the still-active bets so the play
    // balance isn't silently eaten. (Real flights settle on-chain; nothing to refund.)
    if (this.mode === "demo" && (this.state === "flying" || this.state === "takeoff")) {
      let refund = 0;
      this.bets.forEach((b) => { if (b.active && !b.cashed) { refund += b.stake; b.active = false; } });
      if (refund > 0) { this.balance = Math.round((this.balance + refund) * 100) / 100; this._save(); }
    }
    this.mode = m;
    this._realEpoch = (this._realEpoch || 0) + 1; // abandon any pending real round's resolution
    try { Riser.stop(); } catch (e) {}
    this.bets.forEach((b) => { b.betPlaced = false; b.active = false; b.cashed = false; b.autoBet = false; this._syncPanel(b); });
    this._realBusy = false; this._realRes = null;
    if (m === "real") { this._enabled = false; this._startRealIdle(); }
    else { this._enabled = true; this._startBetting(); }
  };

  root.PlaneGame = PlaneGame;
})(typeof globalThis !== "undefined" ? globalThis : this);
