// poker-ui.js — the full-width poker table view + client-side hand loop (Phase 1).
// Drives Poker.PokerHand locally with PokerBots filling the other seats. The hero
// always sits at seat 0 (bottom-center). Money is injected by app.js via config()
// so buy-in/settle can hook the in-game balance.
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const SEATS = 9;             // ring capacity (casino-standard full ring)
  const HERO = "hero";
  const SB = 1, BB = 2;        // chips; 1 chip = $1
  const TURN_MS = 30000;       // hero turn timer
  const BOT_NAMES = ["Ace", "Maverick", "Lola", "Slick", "Duke", "Nova", "Rex", "Cleo", "Iris", "Gus", "Pip"];

  let cfg = { getBalanceUsd: () => 0, onSit: () => {}, onLeave: () => {}, usd: (n) => "$" + Math.round(n), toast: () => {} };
  let seats = new Array(SEATS).fill(null); // each: {id,name,isBot,stack,seat}
  let buttonSeat = 0;
  let hand = null;
  let heroBuyIn = 0;
  let turnTimer = null, turnStart = 0;
  let busy = false;

  // ---- ellipse seat positions (hero at bottom-center) --------------------
  function seatPos(i) {
    const cx = 50, cy = 50, a = 46, b = 44;
    const ang = (90 - (360 / SEATS) * i) * Math.PI / 180;
    return { left: cx + a * Math.cos(ang), top: cy + b * Math.sin(ang) };
  }

  function build() {
    const rail = document.querySelector("#poker-table .poker-rail");
    // remove any prior seats
    rail.querySelectorAll(".pseat").forEach((n) => n.remove());
    for (let i = 0; i < SEATS; i++) {
      const pos = seatPos(i);
      const el = document.createElement("div");
      el.className = "pseat is-empty";
      el.dataset.seat = String(i);
      el.style.left = pos.left + "%";
      el.style.top = pos.top + "%";
      el.innerHTML =
        '<div class="pseat__cards"></div>' +
        '<div class="pseat__pod"><div class="pseat__av">🤖<span class="pseat__d">D</span></div>' +
        '<div class="pseat__meta"><div class="pseat__name"></div><div class="pseat__stack"></div></div></div>' +
        '<button class="pseat__join">+ SIT</button>' +
        '<div class="pseat__bet"></div>';
      el.querySelector(".pseat__join").onclick = () => onSeatClick(i);
      rail.appendChild(el);
    }
    wireActionsArea();
  }

  function onSeatClick(i) {
    if (seatOf(HERO)) { cfg.toast("You're already seated.", "err"); return; }
    openBuyIn();
  }
  function seatOf(id) { return seats.find((s) => s && s.id === id) || null; }

  // ---- buy-in ------------------------------------------------------------
  function openBuyIn() {
    const bal = Math.floor(cfg.getBalanceUsd());
    if (bal < 20) { cfg.toast("You need at least $20 in-game balance to sit. Deposit first.", "err"); return; }
    const max = Math.min(bal, 1000);
    const range = $("poker-buyin-range");
    range.min = 20; range.max = max; range.step = 5;
    range.value = Math.min(100, max);
    const upd = () => { $("poker-buyin-amt").textContent = cfg.usd(+range.value); };
    range.oninput = upd; upd();
    $("poker-buyin").classList.remove("hidden");
    $("poker-buyin-cancel").onclick = () => $("poker-buyin").classList.add("hidden");
    $("poker-buyin-go").onclick = () => { $("poker-buyin").classList.add("hidden"); sitDown(+range.value); };
  }

  function sitDown(buyInUsd) {
    heroBuyIn = buyInUsd;
    cfg.onSit(buyInUsd); // reserve from balance
    seats[0] = { id: HERO, name: "You", isBot: false, stack: buyInUsd, seat: 0 };
    // seat a friendly number of house bots around the table
    const nBots = 5;
    const spread = [5, 3, 7, 2, 6, 4, 8, 1]; // seats around a 9-max ring (hero is seat 0)
    let placed = 0;
    for (const s of spread) { if (placed >= nBots) break; if (!seats[s]) { seats[s] = { id: "bot" + s, name: BOT_NAMES[placed % BOT_NAMES.length], isBot: true, stack: 100, seat: s }; placed++; } }
    buttonSeat = 0;
    $("poker-leave").hidden = false;
    updateChips();
    nextHand();
  }

  function leaveTable() {
    if (hand && !hand.done) { cfg.toast("Finish the current hand first.", "err"); return; }
    const hero = seats[0];
    const finalStack = hero ? hero.stack : 0;
    cfg.onLeave(finalStack); // credit chips back to balance
    const net = finalStack - heroBuyIn;
    cfg.toast("Left the table. Net " + (net >= 0 ? "+" : "−") + cfg.usd(Math.abs(net)) + " to your balance.", net >= 0 ? "ok" : "err");
    seats = new Array(SEATS).fill(null);
    hand = null; clearTurnTimer();
    $("poker-leave").hidden = true;
    $("poker-status").textContent = "Take a seat to start playing.";
    $("poker-board").innerHTML = ""; $("poker-hole").innerHTML = ""; $("poker-actions").innerHTML = ""; $("poker-hint").textContent = "";
    $("poker-pot").textContent = "POT $0";
    updateChips();
    render();
  }

  function updateChips() { const h = seats[0]; $("poker-chips").textContent = cfg.usd(h ? h.stack : cfg.getBalanceUsd()); }

  // ---- hand lifecycle ----------------------------------------------------
  function occupiedSeats() { return seats.filter((s) => s && s.stack > 0); }

  function nextHand() {
    // top up / refresh bots so the table stays alive; drop busted bots
    for (let i = 1; i < SEATS; i++) { if (seats[i] && seats[i].isBot && seats[i].stack < BB) seats[i].stack = 100; }
    const hero = seats[0];
    if (!hero || hero.stack < BB) { offerRebuy(); return; }
    const occ = occupiedSeats();
    if (occ.length < 2) { $("poker-status").textContent = "Waiting for opponents…"; return; }
    // advance button to next occupied seat
    buttonSeat = nextOccupiedSeat(buttonSeat);
    const players = occ.slice().sort((x, y) => x.seat - y.seat).map((s) => ({ id: s.id, name: s.name, isBot: s.isBot, stack: s.stack, seat: s.seat }));
    const buttonIndex = players.findIndex((p) => p.seat === buttonSeat);
    hand = new Poker.PokerHand({ players, buttonIndex: buttonIndex < 0 ? 0 : buttonIndex, smallBlind: SB, bigBlind: BB });
    hand.start();
    $("poker-status").textContent = "";
    render();
    loop();
  }

  function nextOccupiedSeat(from) {
    for (let k = 1; k <= SEATS; k++) { const j = (from + k) % SEATS; if (seats[j] && seats[j].stack > 0) return j; }
    return from;
  }

  async function loop() {
    while (hand && !hand.done) {
      const id = hand.state().toActId;
      if (!id) break;
      if (id === HERO) { promptHero(); return; }
      // bot acts after a short, human-ish pause
      await sleep(500 + Math.random() * 600);
      if (!hand || hand.done) return;
      const st = hand.state(id);
      const la = hand.legalActions(id);
      const a = PokerBots.decide(st, la, { rng: Math.random, aggression: 0.5 });
      try { hand.act(id, a.type, a.amount); } catch (e) { try { hand.act(id, la.canCheck ? "check" : "fold"); } catch (e2) {} }
      render();
    }
    if (hand && hand.done) endHand();
  }

  function endHand() {
    clearTurnTimer();
    // sync table stacks from the hand
    for (const p of hand.players) { const s = seatOf(p.id); if (s) s.stack = p.stack; }
    // describe the result
    const w = hand.winners || [];
    let msg = "";
    if (w.length) {
      const names = Array.from(new Set(w.flatMap((x) => x.ids))).map((id) => (seatOf(id) || {}).name || id);
      msg = names.join(", ") + (names.length > 1 ? " split the pot" : " wins the pot");
      const heroD = hand.deltas[HERO] || 0;
      if (heroD > 0) msg += " · you +" + cfg.usd(heroD);
      else if (heroD < 0) msg += " · you −" + cfg.usd(-heroD);
    }
    $("poker-status").textContent = msg;
    $("poker-actions").innerHTML = "";
    $("poker-hint").textContent = "";
    render();
    updateChips();
    // brief pause, then next hand
    setTimeout(() => { if (seats[0]) nextHand(); }, 2600);
  }

  function offerRebuy() {
    $("poker-status").textContent = "You're out of chips.";
    const bal = Math.floor(cfg.getBalanceUsd());
    const acts = $("poker-actions"); acts.innerHTML = "";
    if (bal >= 20) {
      const b = mkBtn("REBUY", "raise", () => openBuyInRebuy());
      acts.appendChild(b);
    }
    const l = mkBtn("LEAVE", "fold", leaveTable);
    acts.appendChild(l);
  }
  function openBuyInRebuy() {
    // simple: add another buy-in worth from balance at the same seat
    const bal = Math.floor(cfg.getBalanceUsd());
    const amt = Math.min(100, Math.min(bal, 1000));
    if (amt < 20) { cfg.toast("Not enough balance to rebuy.", "err"); return; }
    cfg.onSit(amt); heroBuyIn += amt; seats[0].stack += amt; updateChips(); nextHand();
  }

  // ---- hero turn ---------------------------------------------------------
  function promptHero() {
    const la = hand.legalActions(HERO);
    const acts = $("poker-actions"); acts.innerHTML = "";
    acts.appendChild(mkBtn("FOLD", "fold", () => heroAct("fold")));            // always available, fixed left
    if (la.canCheck) acts.appendChild(mkBtn("CHECK", "check", () => heroAct("check")));
    else if (la.canCall) acts.appendChild(mkBtn("CALL " + cfg.usd(la.callAmount), "call", () => heroAct("call")));
    if (la.canBet || la.canRaise) buildRaiseControl(acts, la);
    $("poker-hint").textContent = "Your turn.";
    startTurnTimer();
    render();
  }

  function buildRaiseControl(acts, la) {
    const isBet = la.canBet;
    const minTo = isBet ? (la.minBet + la.committed) : la.minRaiseTo;
    const maxTo = la.maxRaiseTo;
    if (maxTo <= (la.committed + la.toCall)) return; // can't raise (would just be a call/all-in handled by call)
    const wrap = document.createElement("div"); wrap.className = "praise-wrap";
    const presets = document.createElement("div"); presets.className = "praise-presets";
    const range = document.createElement("input"); range.type = "range"; range.min = minTo; range.max = maxTo; range.step = 1; range.value = Math.min(Math.max(minTo, Math.round((hand.state().pot) * 0.6) + la.committed), maxTo);
    const amt = document.createElement("span"); amt.className = "praise-amt";
    const sync = () => { amt.textContent = cfg.usd(+range.value); };
    range.oninput = sync; sync();
    const pot = hand.state().pot;
    [["½", 0.5], ["¾", 0.75], ["POT", 1], ["MAX", null]].forEach(([lab, f]) => {
      const b = document.createElement("button"); b.className = "ppreset"; b.textContent = lab;
      b.onclick = () => { let t = f == null ? maxTo : (isBet ? la.committed : la.committed + la.toCall) + Math.round(pot * f); range.value = Math.max(minTo, Math.min(maxTo, t)); sync(); };
      presets.appendChild(b);
    });
    const go = mkBtn(isBet ? "BET" : "RAISE", "raise", () => heroAct(isBet ? "bet" : "raise", +range.value));
    wrap.appendChild(presets); wrap.appendChild(range); wrap.appendChild(amt); wrap.appendChild(go);
    acts.appendChild(wrap);
  }

  function heroAct(type, amount) {
    if (!hand || hand.done || hand.state().toActId !== HERO) return;
    clearTurnTimer();
    try { hand.act(HERO, type, amount); } catch (e) { cfg.toast(e.message, "err"); promptHero(); return; }
    $("poker-actions").innerHTML = ""; $("poker-hint").textContent = "";
    render();
    loop();
  }

  function startTurnTimer() {
    clearTurnTimer(); turnStart = Date.now();
    turnTimer = setInterval(() => {
      const left = TURN_MS - (Date.now() - turnStart);
      const frac = Math.max(0, left / TURN_MS);
      const seatEl = document.querySelector('.pseat[data-seat="0"] .pseat__av');
      if (seatEl) seatEl.style.setProperty("--timer", (frac * 360) + "deg");
      if (left <= 0) { const la = hand.legalActions(HERO); heroAct(la.canCheck ? "check" : "fold"); }
    }, 200);
  }
  function clearTurnTimer() { if (turnTimer) { clearInterval(turnTimer); turnTimer = null; } const e = document.querySelector('.pseat[data-seat="0"] .pseat__av'); if (e) e.style.removeProperty("--timer"); }

  // ---- rendering ---------------------------------------------------------
  function cardEl(card, cls) {
    const d = document.createElement("div");
    if (!card) { d.className = "pcard " + (cls || "") + " back"; return d; }
    const red = card.suit === 1 || card.suit === 2;
    d.className = "pcard " + (cls || "") + (red ? " red" : "");
    d.innerHTML = '<span class="pc-r">' + Poker.rankLabel(card.rank) + '</span><span class="pc-s">' + "♠♥♦♣"[card.suit] + "</span>";
    return d;
  }

  function render() {
    const st = hand ? hand.state(HERO) : null;
    // pot + board
    $("poker-pot").textContent = "POT " + cfg.usd(st ? st.pot : 0);
    const board = $("poker-board"); board.innerHTML = "";
    const bcards = st ? st.board : [];
    for (let i = 0; i < 5; i++) { board.appendChild(i < bcards.length ? cardEl(bcards[i]) : (function () { const e = document.createElement("div"); e.className = "pcard empty"; return e; })()); }
    // hero hole cards
    const hole = $("poker-hole"); hole.innerHTML = "";
    const heroP = st && st.players.find((p) => p.id === HERO);
    if (heroP && heroP.hole) { heroP.hole.forEach((c) => hole.appendChild(cardEl(c, "lg"))); if (st.done && hand.shown[HERO]) {} }
    // seats
    for (let i = 0; i < SEATS; i++) {
      const el = document.querySelector('.pseat[data-seat="' + i + '"]'); if (!el) continue;
      const s = seats[i];
      const ps = st && s ? st.players.find((p) => p.id === s.id) : null;
      el.classList.toggle("is-empty", !s);
      el.classList.toggle("joinable", !s && i === 0 && !seatOf(HERO));
      el.classList.toggle("is-hero", !!s && s.id === HERO);
      el.classList.toggle("is-active", !!(st && st.toActId && s && s.id === st.toActId));
      el.classList.toggle("is-folded", !!(ps && ps.folded));
      el.classList.toggle("is-allin", !!(ps && ps.allIn));
      el.classList.toggle("has-button", !!(st && s && ps && st.button != null && hand.players[st.button] && hand.players[st.button].id === s.id));
      if (s) {
        el.querySelector(".pseat__name").textContent = s.name;
        el.querySelector(".pseat__stack").textContent = cfg.usd(ps ? ps.stack : s.stack) + (ps && ps.allIn ? " ALL-IN" : "");
        el.querySelector(".pseat__av").firstChild.nodeValue = s.id === HERO ? "🧑" : "🤖";
        const bet = el.querySelector(".pseat__bet"); bet.textContent = ps && ps.committedStreet > 0 ? cfg.usd(ps.committedStreet) : "";
        // seat cards
        const sc = el.querySelector(".pseat__cards"); sc.innerHTML = "";
        if (ps && ps.hasCards && !ps.folded) {
          if (s.id === HERO) { /* shown big below */ }
          else if (st.done && ps.hole) { ps.hole.forEach((c) => sc.appendChild(cardEl(c, "sm"))); }
          else { sc.appendChild(cardEl(null, "sm")); sc.appendChild(cardEl(null, "sm")); }
        }
      }
    }
  }

  function wireActionsArea() {
    const leave = $("poker-leave"); if (leave) leave.onclick = leaveTable;
  }

  function mkBtn(label, cls, fn) { const b = document.createElement("button"); b.className = "pbtn " + cls; b.textContent = label; b.onclick = fn; return b; }
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  // ---- public API --------------------------------------------------------
  window.PokerUI = {
    mounted: false,
    config(opts) { cfg = Object.assign(cfg, opts || {}); },
    mount() { if (this.mounted) return; build(); this.mounted = true; render(); },
    show() { this.mount(); $("poker-view").hidden = false; render(); },
    hide() { const v = $("poker-view"); if (v) v.hidden = true; },
    leaveTable,
    isSeated() { return !!seatOf(HERO); },
  };
})();
