/* ============================================================
   pressure-ui.js — PRESSURE: glue between DOM controls, the engine, and the
   renderer. Owns the state machine and the input layer.

   States: IDLE/ARMED -> INFLATING -> RESOLVING -> RESULT -> (RECEIPT) -> ARMED
   Money is computed ONLY by PressureEngine; the renderer only draws.

   Every pointerup / pointercancel / blur / visibilitychange resolves as
   RELEASE-AT-CURRENT (never a pop) — a dropped gesture can't cost a round.

   new PressureGame({ mount, els:{...}, balanceKey })
   ============================================================ */
(function (root) {
  "use strict";
  const E = root.PressureEngine;

  const REF_MULT = 6;            // progress=1 ~ reaching 6x (drives cracks/jitter, B-independent)
  const RESET_MS = 1500;
  const ETH_USD = 3400;          // demo ETH price; the live site uses the real feed
  const MIN_BET = 10;            // $10 minimum, settled in the equivalent ETH
  const MAX_BET = 500;           // TOKEN (real-money) stake cap
  const DEMO_BET_MAX = 1000;     // DEMO (play-money) stake cap — higher so demo play feels unlimited
  const MIN_CASHOUT = 1.20;      // must inflate past this to bank — earlier release = refund
                                 // (kills the "tap at ~1.0x for tiny risk-free-feeling wins" exploit feel)

  function PressureGame(opts) {
    this.els = opts.els || {};
    this.houseEdge = opts.houseEdge != null ? opts.houseEdge : E.DEFAULTS.houseEdge;
    this.cap = opts.cap || E.DEFAULTS.cap;
    this.valveFraction = E.DEFAULTS.valveFraction;
    this.pumpSpeed = "normal";
    this.autoMult = E.DEFAULTS.autoRelease;
    this.autoOn = (opts.autoOn != null) ? !!opts.autoOn : true; // token mode passes false (manual default)

    // provably-fair seed chain (one server seed for the session in this demo)
    this.serverSeed = E.randomSeed(24);
    this.clientSeed = (this.els.pfClient && this.els.pfClient.value) || E.randomSeed(8);
    this.nonce = 0;
    this.commitHash = E.commit(this.serverSeed);

    // balance — bridged to the host's shared play-money credits when provided
    // (opts.initialBalance + opts.onBalance), otherwise self-persisted.
    this.balanceKey = opts.balanceKey || "pressure.balance";
    this.ethUsd = opts.ethUsd > 0 ? opts.ethUsd : ETH_USD;
    this.onBalance = typeof opts.onBalance === "function" ? opts.onBalance : null;
    this.onWin = typeof opts.onWin === "function" ? opts.onWin : null;
    // TOKEN mode (server-paced live round via CrashRounds): HOLD starts the round, RELEASE
    // is the manual cash-out, the pop is the server's committed burst. The hold-and-release
    // mechanic the on-chain model couldn't settle provably-fairly.
    this.onTokenLaunch = typeof opts.onTokenLaunch === "function" ? opts.onTokenLaunch : null;   // (stake,autoTargetOr0,onTick)→Promise<result>
    this.onTokenCashOut = typeof opts.onTokenCashOut === "function" ? opts.onTokenCashOut : null; // ()→request server cash-out
    this._disabled = false;
    this._active = false; // only true while this channel is on-screen (gates global input)
    this.balance = (opts.initialBalance != null && isFinite(opts.initialBalance)) ? opts.initialBalance : this._loadBalance();
    this.bet = MIN_BET;

    // round state
    this.state = "idle";
    this.pressing = false;
    this.heldSec = 0;
    this.floors = [];
    this.burst = 0;
    this._resetTimer = null;

    // 3D red balloon (Three.js) — optional; when present the Pixi renderer goes
    // transparent and hides its 2D balloon, and we drive the 3D one in parallel.
    this._b3d = opts.balloon3d || null;
    // renderer
    this.r = new root.PressureRenderer({
      mount: opts.mount, width: opts.width || 480, height: opts.height || 640,
      onTick: (dt) => this._tick(dt), transparent: !!this._b3d,
    });

    this._wire();
    this._renderHud();
    if (this.r.setMinLine) this.r.setMinLine(MIN_CASHOUT);
    this._setAuto(this.autoMult);
    this.r.setState("armed");
    this.state = "armed";
    this._msg(this._idlePrompt());
  }

  // ---------------- HUD / balance ----------------
  PressureGame.prototype._loadBalance = function () {
    const v = parseFloat(localStorage.getItem(this.balanceKey));
    return isFinite(v) && v >= 0 ? v : 5000;
  };
  PressureGame.prototype._saveBalance = function () {
    try { localStorage.setItem(this.balanceKey, String(Math.round(this.balance * 100) / 100)); } catch (e) {}
    if (this.onBalance) try { this.onBalance(this.balance); } catch (e) {}
  };
  PressureGame.prototype._fmt = function (n) { return (Math.round(n * 100) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  PressureGame.prototype._usd = function (n) { return "$" + this._fmt(n); };
  PressureGame.prototype._eth = function (n) { return "Ξ" + (n / (this.ethUsd || ETH_USD)).toFixed(4); };
  PressureGame.prototype._msg = function (t) { if (this.els.message) this.els.message.textContent = t; };
  // Stake is editable only when a balloon ISN'T in play (locks during inflate/resolve).
  PressureGame.prototype._canEditBet = function () {
    return this.state !== "inflating" && this.state !== "resolving";
  };
  PressureGame.prototype._renderHud = function () {
    const canEdit = this._canEditBet(); const e = this.els;
    [e.bet, e.betSlider, e.betUp, e.betDown, e.betHalf, e.betDouble, e.betMax].forEach((el) => { if (el) el.disabled = !canEdit; });
    if (this.els.balance) this.els.balance.textContent = this._usd(this.balance);
    if (this.els.balanceEth) this.els.balanceEth.textContent = "≈ " + this._eth(this.balance);
    if (this.els.bet) this.els.bet.value = this.bet;
    // Bet slider: span $10 -> stake cap (demo lifts it to $1,000; token keeps $500).
    if (this.els.betSlider) {
      var _capBet = this._tokenActive() ? MAX_BET : DEMO_BET_MAX;
      this.els.betSlider.max = String(Math.max(MIN_BET, Math.min(_capBet, Math.round(this.balance) || MIN_BET)));
      this.els.betSlider.value = String(Math.min(this.bet, +this.els.betSlider.max));
    }
    if (this.els.betVal) this.els.betVal.textContent = this._usd(this.bet);
    if (this.els.betEth) this.els.betEth.textContent = "≈ " + this._eth(this.bet);
    if (this.els.pfHash) this.els.pfHash.textContent = this.commitHash.slice(0, 16) + "…";
    if (this.els.pfNonce) this.els.pfNonce.textContent = String(this.nonce);
    if (this.els.addCredits) this.els.addCredits.classList.toggle("hidden", this.balance >= this.bet);
    this._updateActBtn();
  };
  // Fill the uniform action button's "BET $X · WIN $Y" amounts. Win is the profit
  // if you bank at the auto cash-out target.
  PressureGame.prototype._updateActBtn = function () {
    const b = document.getElementById("pr-bet-hint"); if (b) b.textContent = Math.max(0, Math.round(this.bet));
    const w = document.getElementById("pr-win-hint"); if (w) w.textContent = (this.bet * Math.max(0, this.autoMult - 1)).toFixed(2);
    // Mode-aware verb: demo holds, token taps. (The HOLD button HTML defaults to "HOLD TO PUMP".)
    const verb = document.querySelector("#pr-hold .ab-verb");
    if (verb) verb.textContent = this._tokenActive()
      ? ((this.pressing && this.state === "inflating") ? "💰 TAP TO BANK" : "🎈 TAP TO LAUNCH")
      : "🎈 HOLD TO PUMP";
  };

  // ---------------- input wiring ----------------
  PressureGame.prototype._wire = function () {
    const els = this.els;
    // Two control models. DEMO = hold-to-pump: pointer-DOWN inflates, pointer-UP banks (you control
    // the climb by how long you hold). TOKEN = server-paced rounds, which can't use hold — lifting
    // the pointer would bank at ~1x the instant your finger leaves — so token mode is TAP-based: a
    // tap LAUNCHES, a second tap BANKS, and pointer-UP does nothing. (THIS is the "won't let me hold
    // to pump" bug: under the old wiring a token round banked the moment you released.)
    const press = (e) => { if (e && e.cancelable) e.preventDefault(); if (this._tokenActive()) this._tokenTap(); else this._press(); };
    const release = () => { if (this._tokenActive()) return; this._release(); }; // token: never bank on pointer-lift

    // ONLY the HOLD button starts a pump — tapping the TV screen/canvas must NOT
    // place a bet (the canvas is display-only; let touches there scroll normally).
    if (els.holdPad) { els.holdPad.style.touchAction = "none"; els.holdPad.addEventListener("pointerdown", press); }
    // release on ANY of these — never a pop (demo only; token settles by the next tap / server clock)
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    window.addEventListener("blur", release);
    document.addEventListener("visibilitychange", () => { if (document.hidden) release(); });

    // keyboard: SPACE = hold (demo) / tap (token), V valve, A toggle auto
    const modalUp = () => !!document.querySelector(".modal:not(.hidden)");
    window.addEventListener("keydown", (e) => {
      if (e.repeat || !this._active) return; // only when Balloon Pop is the active channel
      const tag = (e.target && e.target.tagName) || "";
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      if (modalUp()) return; // don't pump behind an open dialog
      if (e.code === "Space") { e.preventDefault(); if (this._tokenActive()) this._tokenTap(); else this._press(); }
      else if (e.key === "a" || e.key === "A") this._toggleAuto();
      else if (e.key === "v" || e.key === "V") this._valve(); // lock a pop-proof floor at the current mult
    });
    window.addEventListener("keyup", (e) => { if (this._active && e.code === "Space" && !modalUp() && !this._tokenActive()) this._release(); });

    // bet controls ($ value, $10 minimum)
    const betStep = (b) => (b < 100 ? 10 : b < 1000 ? 50 : 100);
    const setBet = (v) => {
      // Stake LOCKS the moment the balloon starts inflating — otherwise sliding it
      // mid-pump would change the payout (stake is deducted at press, but the
      // win is computed on the current stake). Editable while armed/idle/result.
      if (!this._canEditBet()) { this._renderHud(); return; }
      this.bet = Math.max(MIN_BET, Math.min(this._tokenActive() ? MAX_BET : DEMO_BET_MAX, Math.round(v * 100) / 100)); this._renderHud();
    };
    if (els.betUp) els.betUp.addEventListener("click", () => setBet(this.bet + betStep(this.bet)));
    if (els.betDown) els.betDown.addEventListener("click", () => setBet(this.bet - betStep(this.bet - 0.01)));
    if (els.betHalf) els.betHalf.addEventListener("click", () => setBet(this.bet / 2));
    if (els.betDouble) els.betDouble.addEventListener("click", () => setBet(this.bet * 2));
    if (els.betMax) els.betMax.addEventListener("click", () => setBet(Math.min(this._tokenActive() ? MAX_BET : DEMO_BET_MAX, this.balance)));
    if (els.bet) els.bet.addEventListener("change", () => setBet(parseFloat(els.bet.value) || MIN_BET));
    if (els.betSlider) els.betSlider.addEventListener("input", () => setBet(parseFloat(els.betSlider.value) || MIN_BET));
    if (els.addCredits) els.addCredits.addEventListener("click", () => { this.balance += 1000; this._saveBalance(); this._renderHud(); this._msg("+$1,000.00 added"); });

    // risk / auto
    if (els.risk) els.risk.addEventListener("change", () => { this.pumpSpeed = els.risk.value; });
    const setAuto = (v) => {
      this.autoMult = Math.max(MIN_CASHOUT, Math.round(v * 100) / 100);
      if (els.autoSlider) els.autoSlider.value = this.autoMult;
      if (els.auto) els.auto.value = this.autoMult.toFixed(2);
      if (els.autoVal) els.autoVal.textContent = this.autoMult.toFixed(2) + "x";
      this.r.setAutoLine(this.autoMult);
      this._updateActBtn();
    };
    this._setAuto = setAuto;
    if (els.autoSlider) els.autoSlider.addEventListener("input", () => setAuto(parseFloat(els.autoSlider.value)));
    if (els.auto) els.auto.addEventListener("change", () => setAuto(parseFloat(els.auto.value) || 2));
    if (els.autoToggle) els.autoToggle.addEventListener("click", () => this._toggleAuto());

    // provably fair
    if (els.pfClient) els.pfClient.addEventListener("change", () => { this.clientSeed = els.pfClient.value || E.randomSeed(8); });
    if (els.pfVerify) els.pfVerify.addEventListener("click", () => this._verifyLast());
  };

  PressureGame.prototype._toggleAuto = function () {
    this.autoOn = !this.autoOn;
    if (this.els.autoToggle) {
      this.els.autoToggle.textContent = this.autoOn ? "AUTO ON" : "AUTO OFF";
      this.els.autoToggle.classList.toggle("active", this.autoOn);
    }
  };

  // True when a token session is open and this game was wired for it → server-paced rounds.
  PressureGame.prototype._tokenActive = function () {
    return !!(this.onTokenLaunch && root.TokenMode && root.TokenMode.active());
  };

  // TOKEN mode is TAP-based (hold-to-pump can't work with a server-paced round — lifting the pointer
  // would bank at ~1x the moment your finger leaves). A tap LAUNCHES a round; a second tap BANKS it.
  PressureGame.prototype._tokenTap = function () {
    if (!this._active) return;
    if (document.querySelector(".modal:not(.hidden)")) return; // a dialog is open over the canvas
    if (this.pressing && this.state === "inflating") { if (this.onTokenCashOut) this.onTokenCashOut(); return; } // climbing → this tap banks it
    if (this.state !== "armed" && this.state !== "idle") return; // mid-resolve / showing a result → ignore taps
    this._pressToken();
  };

  // The "ready to play" prompt, worded for the active mode (token taps; demo holds).
  PressureGame.prototype._idlePrompt = function () {
    if (this._tokenActive()) return (root.TokenMode.tokens() < this.bet) ? "Tap 🪙 Buy in above to play" : "Tap to launch — then tap to bank";
    return this.balance < this.bet ? "Add funds to keep playing" : "HOLD the balloon to pump";
  };

  // ---------------- round lifecycle ----------------
  PressureGame.prototype._press = function () {
    if (!this._active) return; // off-channel: ignore global SPACE / pointer input
    if (document.querySelector(".modal:not(.hidden)")) return; // a dialog is open over the canvas
    if (this.pressing) return;
    if (this.state !== "armed" && this.state !== "idle") return;
    if (this._disabled && !this._tokenActive()) { this._msg("🎈 Pressure is play-money only — disconnect to play it in demo."); return; }
    if (this._tokenActive()) return this._pressToken(); // token mode: server-paced hold/release
    if (this.balance < this.bet) { this._msg("Not enough balance — add funds"); this._renderHud(); return; }

    // commit money + derive the SEALED burst (hidden from the renderer)
    this.balance = Math.round((this.balance - this.bet) * 100) / 100;
    this.nonce += 1;
    this.burst = E.deriveBurst(this.serverSeed, this.clientSeed, this.nonce, this.houseEdge, this.cap);
    this.floors = [];
    this.heldSec = 0;
    this.pressing = true;
    this.state = "inflating";
    this._roundToken = false; // #47: this round started in DEMO mode — release resolves locally
    this.r.reset();              // fresh limp balloon
    if (this._b3d) this._b3d.reset();
    this.r.setState("inflating");
    this.r.setAutoLine(this.autoMult);
    this._renderHud();
    this._msg("Pumping… release to bank before it pops!");
    if (root.Chiptune && Chiptune.blip) try { Chiptune.blip(); } catch (e) {}
  };

  // TOKEN HOLD: start a server-paced round. The climb is driven by onTick (server clock);
  // RELEASE (or leaving the channel) requests the cash-out; the pop is the server's burst.
  PressureGame.prototype._pressToken = function () {
    var TM = root.TokenMode;
    if (TM.tokens() < this.bet) { this._msg("Not enough tokens — buy in"); this._renderHud(); return; }
    var stake = this.bet;
    var autoTarget = this.autoOn ? this.autoMult : 0; // 0 = MANUAL release (the default in token mode)
    this.nonce += 1; this.floors = []; this.heldSec = 0; this.burst = 0;
    this.pressing = true; this.state = "inflating";
    this._roundToken = true; // #47: this round started as a TOKEN (server-paced) round — release must cash out server-side
    this.r.reset(); if (this._b3d) this._b3d.reset();
    this.r.setState("inflating");
    if (this.r.setAutoLine) this.r.setAutoLine(autoTarget || 0);
    this.balance = Math.round((TM.tokens() - stake) * 100) / 100; // anchor to tokens, debit the stake
    this._renderHud();
    this._msg(autoTarget ? "Pumping… auto-banks at " + autoTarget.toFixed(2) + "x" : "Pumping… tap to bank before it pops!");
    if (root.Chiptune && Chiptune.blip) try { Chiptune.blip(); } catch (e) {}
    var self = this, epoch = (this._tokenEpoch = (this._tokenEpoch || 0) + 1);
    var onTick = function (m, elapsed, result) {
      if (epoch !== self._tokenEpoch || !self._active || self.state !== "inflating") return;
      if (result) return; // settle frame handled by .then
      var progress = Math.min(1, Math.log(Math.max(1, m)) / Math.log(REF_MULT));
      self.r.setLive(m, progress);
      if (self._b3d) self._b3d.setPressure(progress);
    };
    Promise.resolve(this.onTokenLaunch(stake, autoTarget, onTick)).then(function (res) {
      if (epoch !== self._tokenEpoch) return;       // superseded (left + re-entered)
      if (!res) { self.pressing = false; self.balance = TM.tokens(); self._toArmed(); return; }
      self._resolveToken(res, stake);
    }).catch(function (e) {
      if (epoch !== self._tokenEpoch) return;
      self.pressing = false;
      // CRITICAL: clear the "inflating" state BEFORE _toArmed() — _toArmed early-returns while state is
      // "inflating", so without this the button stays stuck on "TAP TO BANK" after a rejected cr:start
      // (e.g. the server refused because a blackjack hand is live) and the player can never tap LAUNCH again.
      self.state = "armed";
      var msg = (e && e.message) || "Round failed — try again";
      if (msg === "CR_ROUND_TIMEOUT") {
        // Round started (stake reserved server-side) but the result timed out. Don't show TM.tokens()
        // (the PRE-reserve cache — would un-do the debit, v2 OPEN#2/#3). Reconcile from the authoritative
        // server session instead. Keep the locally-debited balance until it lands.
        self._msg("Lost the connection mid-round — reconciling your balance…"); self._toArmed();
        try { if (TM && TM.active && TM.active() && TM.refreshTokens) Promise.resolve(TM.refreshTokens()).then(function () { if (epoch === self._tokenEpoch && TM.active()) { self.balance = TM.tokens(); self._renderHud(); } }).catch(function () {}); } catch (x) {}
        return;
      }
      // A genuine failed START (cr:error, stake NOT taken) → safe to re-anchor to the untouched ledger.
      self.balance = TM.tokens(); self._msg("Round failed — try again"); self._toArmed();
    });
  };

  // Render the SERVER result of a token round through the existing pop/win/refund visuals.
  PressureGame.prototype._resolveToken = function (res, stake) {
    this.pressing = false; this.state = "resolving";
    this.burst = res.crashPoint || 0; // the revealed pop-point
    if (typeof res.tokens === "number") this.balance = Math.round(res.tokens * 100) / 100; // authoritative
    var co = res.cashOutAt || 0, payout = res.payoutUnits || 0, profit = Math.max(0, payout - stake);
    var voided = !res.busted && co > 0 && co < MIN_CASHOUT && Math.abs(payout - stake) < 1e-6; // server refunded
    this.lastRound = { nonce: this.nonce, releaseMult: res.busted ? this.burst : co, burst: this.burst, payout: payout, exit: res.busted ? "pop" : (voided ? "void" : "release") };
    if (res.busted) {
      this.r.pop(); if (this._b3d) this._b3d.pop();
      this.r.showReceipt("POP @ " + this.burst.toFixed(2) + "x", false);
      this._msg("💥 POP at " + this.burst.toFixed(2) + "x — lost the bet");
      if (root.Chiptune && Chiptune.lose) try { Chiptune.lose(); } catch (e) {}
    } else if (voided) {
      this.r.refund();
      this._msg("Let go too early (" + co.toFixed(2) + "x) — bet refunded. Reach " + MIN_CASHOUT.toFixed(2) + "x to win.");
    } else {
      this.r.win({ finalMult: co, payout: payout, profit: profit });
      if (this._b3d) this._b3d.bank(profit >= 300 ? "mega" : profit >= 100 ? "big" : "normal");
      this._msg("💰 Banked " + co.toFixed(2) + "x  →  " + this._usd(payout));
      try { var C = root.Chiptune; if (C) { if (profit >= 500 && C.jackpot) C.jackpot(); else if (profit >= 100 && C.bigwin) C.bigwin(); else if (C.win) C.win(); } } catch (e) {}
      if (this.onWin && profit > 0) try { this.onWin({ profitUsd: profit, mult: co }); } catch (e) {}
    }
    this.state = "result"; this._renderHud(); this._updatePfLast();
    clearTimeout(this._resetTimer);
    this._resetTimer = setTimeout(this._toArmed.bind(this), res.busted ? RESET_MS : 3600);
  };

  PressureGame.prototype._tick = function (dt) {
    if (this._tokenActive()) return; // token mode: the climb is driven by the server (onTick), not local time
    if (this.state !== "inflating" || !this.pressing) return;
    this.heldSec += dt;
    const mult = E.multiplierAtTime(this.heldSec, this.pumpSpeed);
    const typical = Math.max(0.5, E.timeForMultiplier(REF_MULT, this.pumpSpeed));
    const progress = Math.min(1, this.heldSec / typical);
    this.r.setLive(mult, progress);
    if (this._b3d) this._b3d.setPressure(progress);

    if (mult >= this.burst) { this._resolve("pop", this.burst); return; }
    if (this.autoOn && mult >= this.autoMult) { this._resolve("auto", this.autoMult); return; }
  };

  PressureGame.prototype._valve = function () {
    if (this._tokenActive()) return; // mega-hunt MEDIUM: valve floor-locks are DEMO-only. In token mode the round is a single server cash-out (no per-floor lock) — showing "pop-proof kept $X" would promise money the server never pays.
    if (this.state !== "inflating" || !this.pressing) return;
    const mult = this.r.getRenderedMultiplier();
    const v = E.valveLock(this.floors, this.valveFraction, mult);
    if (v.floor.fraction <= 0.0001) return; // nothing left to lock
    this.floors.push(v.floor);
    this.r.addValveRing(mult);
    let locked = 0; for (const f of this.floors) locked += f.fraction * f.lockMult * this.bet;
    this.r.setLockedText(locked);
    this._msg("Locked floor at " + mult.toFixed(2) + "x (pop-proof " + this._fmt(locked) + ")");
    if (root.Chiptune && Chiptune.coin) try { Chiptune.coin(); } catch (e) {}
  };

  PressureGame.prototype._release = function () {
    if (this.state !== "inflating" || !this.pressing) return;
    // #47: decide token-vs-demo by how THIS round STARTED (captured at press), not the live TokenMode flag.
    // A mid-round disconnect that flips TokenMode.active() to false must NOT make a token round resolve as a
    // phantom demo win/loss. Fall back to the live check only if the per-round flag was never set.
    var roundToken = (this._roundToken != null) ? this._roundToken : this._tokenActive();
    if (roundToken) { if (this.onTokenCashOut) this.onTokenCashOut(); return; } // server settles at its clock
    const m = Math.floor(this.r.getRenderedMultiplier() * 100) / 100; // snap DOWN to last drawn frame
    if (m >= this.burst) this._resolve("pop", this.burst);
    else if (m < MIN_CASHOUT) this._resolve("void", m);   // let go too early → refund, no win/loss
    else this._resolve("release", m);
  };

  PressureGame.prototype._resolve = function (exit, releaseMult) {
    this.pressing = false;
    this.state = "resolving";

    if (exit === "void") {
      // released before the 1.20x minimum and before bursting → refund the stake
      this.balance = Math.round((this.balance + this.bet) * 100) / 100;
      this._saveBalance();
      this.lastRound = { nonce: this.nonce, releaseMult, burst: this.burst, payout: this.bet, exit: "void" };
      this.r.refund();
      this._msg("Let go too early (" + releaseMult.toFixed(2) + "x) — bet refunded. Reach " + MIN_CASHOUT.toFixed(2) + "x to win.");
      this.state = "result";
      this._renderHud();
      this._updatePfLast();
      clearTimeout(this._resetTimer);
      this._resetTimer = setTimeout(() => this._toArmed(), RESET_MS);
      return;
    }

    const res = E.resolveRound({ stake: this.bet, burst: this.burst, releaseMult, floors: this.floors, exit });
    this.balance = Math.round((this.balance + res.payout) * 100) / 100;
    this._saveBalance();

    this.lastRound = { nonce: this.nonce, releaseMult, burst: this.burst, payout: res.payout, exit, lockedSum: res.lockedSum };

    if (res.popped) {
      this.r.pop();
      if (this._b3d) this._b3d.pop(); // 3D shard burst + size-scaled pop sound
      this.r.showReceipt("POP @ " + this.burst.toFixed(2) + "x", false);
      const keptMsg = res.lockedSum > 0 ? ("  · kept " + this._usd(res.lockedSum)) : "";
      this._msg("💥 POP at " + this.burst.toFixed(2) + "x — lost the bet" + keptMsg);
      if (root.Chiptune && Chiptune.lose) try { Chiptune.lose(); } catch (e) {}
    } else {
      this.r.win({ finalMult: releaseMult, payout: res.payout, profit: res.profit });
      if (this._b3d) this._b3d.bank(res.profit >= 300 ? "mega" : res.profit >= 100 ? "big" : "normal"); // 3D relax + glow
      const nearMiss = (this.burst - releaseMult) <= Math.max(0.05, this.burst * 0.03);
      // (the on-canvas "you banked …" receipt was removed — the YOU WIN result
      //  screen now shows the win; keep only the quieter panel status line)
      this._msg((exit === "auto" ? "🔔 Auto-banked " : "💰 Banked ") + releaseMult.toFixed(2) + "x  →  " + this._usd(res.payout) + (nearMiss ? "  (so close!)" : ""));
      // tiered fanfare — louder the bigger the win (the coin-shower ticks are added
      // by the renderer's count-up).
      try { var C = root.Chiptune; if (C) { if (res.profit >= 500 && C.jackpot) C.jackpot(); else if (res.profit >= 100 && C.bigwin) C.bigwin(); else if (C.win) C.win(); } } catch (e) {}
      if (this.onWin && res.profit > 0) try { this.onWin({ profitUsd: res.profit, mult: releaseMult }); } catch (e) {}
    }

    this.state = "result";
    this._renderHud();
    this._updatePfLast();

    clearTimeout(this._resetTimer);
    // let the big win animation fully play out before re-arming; pops reset quicker.
    this._resetTimer = setTimeout(() => this._toArmed(), res.popped ? RESET_MS : 3600);
  };

  PressureGame.prototype._toArmed = function () {
    if (this.state === "inflating") return;
    this.floors = [];
    this.r.clearValveRings();
    this.r.reset();
    if (this._b3d) this._b3d.reset();
    this.state = "armed";
    this._msg(this._idlePrompt());
    this._renderHud();
  };

  // ---------------- provably fair ----------------
  PressureGame.prototype._updatePfLast = function () {
    if (this.els.pfNonce) this.els.pfNonce.textContent = String(this.nonce);
    if (this.els.pfLast && this.lastRound) {
      this.els.pfLast.textContent = "round #" + this.lastRound.nonce + " · burst " + this.lastRound.burst.toFixed(2) + "x";
    }
  };
  PressureGame.prototype._verifyLast = function () {
    if (!this.lastRound) { this._msg("Play a round first, then verify"); return; }
    const v = E.verify(this.serverSeed, this.commitHash, this.clientSeed, this.lastRound.nonce, this.houseEdge, this.cap);
    const ok = v.hashOk && Math.abs(v.burst - this.lastRound.burst) < 1e-9;
    const out = "serverSeed " + this.serverSeed.slice(0, 12) + "… → hash " + (v.hashOk ? "MATCHES ✓" : "MISMATCH ✗") +
      " · recomputed burst " + v.burst.toFixed(2) + "x (" + (ok ? "verified ✓" : "MISMATCH ✗") + ")";
    if (this.els.pfReveal) this.els.pfReveal.textContent = out;
    this._msg(ok ? "✅ Provably fair: round #" + this.lastRound.nonce + " verified" : "⚠️ verification mismatch");
  };

  // ---------------- host integration (embedded as a Crypto TV channel) ----------------
  // Externally set the shared play-money balance (on entering the channel / after
  // a global reset). Won't disturb an in-flight round.
  PressureGame.prototype.setBalance = function (b) {
    if (!isFinite(b) || this.state === "inflating") return;
    this.balance = Math.round(b * 100) / 100;
    if (this.state === "armed" || this.state === "result") this._msg(this._idlePrompt());
    this._renderHud();
  };
  PressureGame.prototype.restartDemo = function () {
    clearTimeout(this._resetTimer); this._resetTimer = null;
    this.pressing = false; this.state = "armed"; this.floors = []; this.heldSec = 0; this.burst = 0;
    this.r.clearValveRings(); this.r.reset(); if (this._b3d) this._b3d.reset();
    this._msg(this._idlePrompt());
    this._renderHud();
  };
  PressureGame.prototype.setEthUsd = function (p) { if (p > 0) { this.ethUsd = p; this._renderHud(); } };
  // Pause/resume the Pixi ticker + global input so the balloon doesn't burn CPU
  // or capture keypresses off-channel.
  PressureGame.prototype.setActive = function (on) {
    this._active = !!on;
    if (!on && this.pressing) this._release(); // never strand a held round when leaving
    // Leaving supersedes any in-flight token round: bump the epoch (after _release requested the
    // cash-out) so a late cr:result .then/.catch + onTick are dropped — no off-channel pop/win/sound (#48).
    if (!on) this._tokenEpoch = (this._tokenEpoch || 0) + 1;
    // v8 #1: the superseded token .then bails on the epoch guard BEFORE it clears pressing/state, so a token
    // round left mid-flight stays latched (pressing=true, state="inflating") → on return LAUNCH is dead and the
    // verb is stuck on "TAP TO BANK" until reload. Re-arm the client here (mirrors plane-ui _startTokenIdle).
    // The server round already settled on its own clock via the onTokenCashOut _release just requested; the
    // authoritative balance re-syncs from TokenMode on re-entry (setBalance) — this reset is display-only.
    // MUST run AFTER _release() (so the cash-out fired while pressing was still true) and AFTER the epoch bump.
    if (!on && (this.pressing || this.state === "inflating")) {
      this.pressing = false;
      this.state = "armed";
      this._roundToken = false;
      this.floors = [];
      clearTimeout(this._resetTimer); this._resetTimer = null;
      try { this.r.clearValveRings(); } catch (e) {}
      try { this.r.reset(); } catch (e) {}
      if (this._b3d) try { this._b3d.reset(); } catch (e) {}
      this._msg(this._idlePrompt());
      this._renderHud();
      try { if (root.TokenMode && root.TokenMode.active && root.TokenMode.active() && root.TokenMode.refreshTokens) root.TokenMode.refreshTokens(); } catch (e) {}
    }
    try { on ? this.r.app.ticker.start() : this.r.app.ticker.stop(); } catch (e) {}
    if (this._b3d) try { this._b3d.setActive(on); } catch (e) {}
  };
  // Real-money mode has no on-chain Pressure yet → lock play with a clear note.
  PressureGame.prototype.setEnabled = function (on) {
    this._disabled = !on;
    if (this._disabled) { this.pressing = false; this._msg("🎈 Pressure is play-money only — disconnect to play it in demo."); }
    else { this._msg(this._idlePrompt()); }
  };

  root.PressureGame = PressureGame;
})(typeof globalThis !== "undefined" ? globalThis : this);
