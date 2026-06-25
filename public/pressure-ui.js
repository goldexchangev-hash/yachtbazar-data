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
  const MIN_CASHOUT = 1.20;      // must inflate past this to bank — earlier release = refund
                                 // (kills the "tap at ~1.0x for tiny risk-free-feeling wins" exploit feel)

  function PressureGame(opts) {
    this.els = opts.els || {};
    this.houseEdge = opts.houseEdge != null ? opts.houseEdge : E.DEFAULTS.houseEdge;
    this.cap = opts.cap || E.DEFAULTS.cap;
    this.valveFraction = E.DEFAULTS.valveFraction;
    this.pumpSpeed = "normal";
    this.autoMult = E.DEFAULTS.autoRelease;
    this.autoOn = true;

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

    // renderer
    this.r = new root.PressureRenderer({
      mount: opts.mount, width: opts.width || 480, height: opts.height || 640,
      onTick: (dt) => this._tick(dt),
    });

    this._wire();
    this._renderHud();
    if (this.r.setMinLine) this.r.setMinLine(MIN_CASHOUT);
    this._setAuto(this.autoMult);
    this.r.setState("armed");
    this.state = "armed";
    this._msg("HOLD the balloon to pump");
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
  PressureGame.prototype._renderHud = function () {
    if (this.els.balance) this.els.balance.textContent = this._usd(this.balance);
    if (this.els.balanceEth) this.els.balanceEth.textContent = "≈ " + this._eth(this.balance);
    if (this.els.bet) this.els.bet.value = this.bet;
    // Bet slider: span $10 → the whole balance, so MAX = all-in.
    if (this.els.betSlider) {
      this.els.betSlider.max = String(Math.max(MIN_BET, Math.round(this.balance) || MIN_BET));
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
  };

  // ---------------- input wiring ----------------
  PressureGame.prototype._wire = function () {
    const els = this.els;
    const press = (e) => { if (e && e.cancelable) e.preventDefault(); this._press(); };
    const release = () => this._release();

    // canvas + hold pad: press-and-hold
    const view = this.r.view;
    view.style.touchAction = "none";
    view.addEventListener("pointerdown", press);
    if (els.holdPad) { els.holdPad.style.touchAction = "none"; els.holdPad.addEventListener("pointerdown", press); }
    // release on ANY of these — never a pop
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    window.addEventListener("blur", release);
    document.addEventListener("visibilitychange", () => { if (document.hidden) release(); });

    // keyboard: SPACE hold, V valve, A toggle auto
    window.addEventListener("keydown", (e) => {
      if (e.repeat || !this._active) return; // only when Balloon Pop is the active channel
      const tag = (e.target && e.target.tagName) || "";
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      if (e.code === "Space") { e.preventDefault(); this._press(); }
      else if (e.key === "a" || e.key === "A") this._toggleAuto();
    });
    window.addEventListener("keyup", (e) => { if (this._active && e.code === "Space") this._release(); });

    // bet controls ($ value, $10 minimum)
    const betStep = (b) => (b < 100 ? 10 : b < 1000 ? 50 : 100);
    const setBet = (v) => { this.bet = Math.max(MIN_BET, Math.round(v * 100) / 100); this._renderHud(); };
    if (els.betUp) els.betUp.addEventListener("click", () => setBet(this.bet + betStep(this.bet)));
    if (els.betDown) els.betDown.addEventListener("click", () => setBet(this.bet - betStep(this.bet - 0.01)));
    if (els.betHalf) els.betHalf.addEventListener("click", () => setBet(this.bet / 2));
    if (els.betDouble) els.betDouble.addEventListener("click", () => setBet(this.bet * 2));
    if (els.betMax) els.betMax.addEventListener("click", () => setBet(this.balance));
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

  // ---------------- round lifecycle ----------------
  PressureGame.prototype._press = function () {
    if (!this._active) return; // off-channel: ignore global SPACE / pointer input
    if (this._disabled) { this._msg("🎈 Pressure is play-money only — disconnect to play it in demo."); return; }
    if (this.pressing) return;
    if (this.state !== "armed" && this.state !== "idle") return;
    if (this.balance < this.bet) { this._msg("Not enough balance — add funds"); this._renderHud(); return; }

    // commit money + derive the SEALED burst (hidden from the renderer)
    this.balance = Math.round((this.balance - this.bet) * 100) / 100;
    this.nonce += 1;
    this.burst = E.deriveBurst(this.serverSeed, this.clientSeed, this.nonce, this.houseEdge, this.cap);
    this.floors = [];
    this.heldSec = 0;
    this.pressing = true;
    this.state = "inflating";
    this.r.reset();              // fresh limp balloon
    this.r.setState("inflating");
    this.r.setAutoLine(this.autoMult);
    this._renderHud();
    this._msg("Pumping… release to bank before it pops!");
    if (root.Chiptune && Chiptune.blip) try { Chiptune.blip(); } catch (e) {}
  };

  PressureGame.prototype._tick = function (dt) {
    if (this.state !== "inflating" || !this.pressing) return;
    this.heldSec += dt;
    const mult = E.multiplierAtTime(this.heldSec, this.pumpSpeed);
    const typical = Math.max(0.5, E.timeForMultiplier(REF_MULT, this.pumpSpeed));
    const progress = Math.min(1, this.heldSec / typical);
    this.r.setLive(mult, progress);

    if (mult >= this.burst) { this._resolve("pop", this.burst); return; }
    if (this.autoOn && mult >= this.autoMult) { this._resolve("auto", this.autoMult); return; }
  };

  PressureGame.prototype._valve = function () {
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
      this.r.showReceipt("POP @ " + this.burst.toFixed(2) + "x", false);
      const keptMsg = res.lockedSum > 0 ? ("  · kept " + this._usd(res.lockedSum)) : "";
      this._msg("💥 POP at " + this.burst.toFixed(2) + "x — lost the bet" + keptMsg);
      if (root.Chiptune && Chiptune.lose) try { Chiptune.lose(); } catch (e) {}
    } else {
      this.r.win({ finalMult: releaseMult, payout: res.payout });
      if (root.Lenny) try { root.Lenny.celebrate({ betUsd: this.bet, winUsd: res.profit }); } catch (e) {}
      const nearMiss = (this.burst - releaseMult) <= Math.max(0.05, this.burst * 0.03);
      this.r.showReceipt("you " + (exit === "auto" ? "auto-" : "") + "banked " + releaseMult.toFixed(2) + "x  ·  pop was " + this.burst.toFixed(2) + "x", nearMiss);
      this._msg((exit === "auto" ? "🔔 Auto-banked " : "💰 Banked ") + releaseMult.toFixed(2) + "x  →  " + this._usd(res.payout) + (nearMiss ? "  (so close!)" : ""));
      if (root.Chiptune && Chiptune.win) try { Chiptune.win(); } catch (e) {}
      if (this.onWin && res.profit > 0) try { this.onWin({ profitUsd: res.profit, mult: releaseMult }); } catch (e) {}
    }

    this.state = "result";
    this._renderHud();
    this._updatePfLast();

    clearTimeout(this._resetTimer);
    this._resetTimer = setTimeout(() => this._toArmed(), RESET_MS);
  };

  PressureGame.prototype._toArmed = function () {
    if (this.state === "inflating") return;
    this.floors = [];
    this.r.clearValveRings();
    this.r.reset();
    this.state = "armed";
    this._msg(this.balance < this.bet ? "Add funds to keep playing" : "HOLD the balloon to pump");
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
    this._renderHud();
  };
  PressureGame.prototype.setEthUsd = function (p) { if (p > 0) { this.ethUsd = p; this._renderHud(); } };
  // Pause/resume the Pixi ticker + global input so the balloon doesn't burn CPU
  // or capture keypresses off-channel.
  PressureGame.prototype.setActive = function (on) {
    this._active = !!on;
    if (!on && this.pressing) this._release(); // never strand a held round when leaving
    try { on ? this.r.app.ticker.start() : this.r.app.ticker.stop(); } catch (e) {}
  };
  // Real-money mode has no on-chain Pressure yet → lock play with a clear note.
  PressureGame.prototype.setEnabled = function (on) {
    this._disabled = !on;
    if (this._disabled) { this.pressing = false; this._msg("🎈 Pressure is play-money only — disconnect to play it in demo."); }
    else { this._msg(this.balance < this.bet ? "Add funds to keep playing" : "HOLD the balloon to pump"); }
  };

  root.PressureGame = PressureGame;
})(typeof globalThis !== "undefined" ? globalThis : this);
