/* deterministic engine tests for double/split/surrender/insurance (stacked shoe) */
const R = require("../public/blackjack-rules.js");
const S = require("../public/blackjack-shuffle.js");
const BJ = require("./blackjack-server.js");

let pass = true;
function chk(c, m) { if (!c) { pass = false; console.log("FAIL:", m); } else console.log("ok  :", m); }
function C(rank, suit) { return { rank, suit }; }
function P(s) { return s.split(" ").map((t) => C(t.length === 2 ? t[0] : t.slice(0, 2), t[t.length - 1])); }
function sock(id) { return { id, sent: [], send(s) { this.sent.push(JSON.parse(s)); }, last(t) { for (let i = this.sent.length - 1; i >= 0; i--) if (this.sent[i].type === t) return this.sent[i]; } }; }
function clock() { let n = 0; const m = new Map(); return { setTimeout: (fn) => { const id = ++n; m.set(id, fn); return id; }, clearTimeout: (id) => m.delete(id) }; }

// run a solo round with a stacked shoe + a list of actions. returns {room, bal, settle, sock, eng}
function runSolo(shoe, actions, opts) {
  opts = opts || {}; const ck = clock(); const start = opts.start == null ? 1000 : opts.start;
  const eng = BJ.attachBlackjack({ bank: BJ.makeBank(start), setTimeout: ck.setTimeout, clearTimeout: ck.clearTimeout,
    timers: { betting: 1e9, turn: 1e9, insurance: 1e9, idle: 1e9, between: 1e9 }, makeShoe: () => shoe.slice(), config: opts.config });
  const p = sock("p"); eng.handle(p, { type: "bj:room:join", wallet: "p" });
  const room = [...eng._mgr.rooms.values()].find((r) => r.seats.some(Boolean));
  eng.handle(p, { type: "bj:bet:place", amountUsd: opts.bet == null ? 100 : opts.bet }); // auto-deals (solo)
  if (room.phase === "insurance") eng.handle(p, { type: "bj:insurance", take: !!opts.insurance });
  (actions || []).forEach((a) => { if (room.phase === "turns") eng.handle(p, { type: "bj:action", action: a }); });
  return { room, bal: eng.bank.get("p"), settle: p.last("bj:settle"), sock: p, eng };
}
function seat0(settle) { return settle.perSeat.find((x) => x.seat === 0); }

console.log("\n== DOUBLE ==");
{ // double to 21, win vs dealer 17
  const r = runSolo(P("5S 9H 6S 8D 10C"), ["double"]);
  const s = seat0(r.settle);
  chk(s.hands[0].doubled && s.hands[0].outcome === "win", "double win: doubled flag + win");
  chk(s.hands[0].delta === 200 && r.bal === 1200, "double win pays on the doubled stake (+200 -> $1200)");
}
{ // double, lose
  const r = runSolo(P("5S 10H 6S 10D 5C"), ["double"]);
  const s = seat0(r.settle);
  chk(s.hands[0].outcome === "lose" && s.hands[0].delta === -200 && r.bal === 800, "double lose: -200 -> $800");
}

console.log("\n== SPLIT ==");
{ // split 8s, both 18, dealer busts -> both win
  const r = runSolo(P("8S 6H 8H 10D 10C 10S 10H"), ["split", "stand", "stand"]);
  const s = seat0(r.settle);
  chk(s.hands.length === 2, "split -> two hands");
  chk(s.hands.every((h) => h.outcome === "win" && h.fromSplit), "both split hands win + flagged fromSplit");
  chk(r.bal === 1200, "split both win (+200 -> $1200)");
}
{ // split aces: one card each, two 21s that are NOT blackjack (pay 1:1)
  const r = runSolo(P("AS 9H AH 7D KC QS 2H"), ["split"]);
  const s = seat0(r.settle);
  chk(s.hands.length === 2 && s.hands.every((h) => h.total === 21), "split aces -> two 21s");
  chk(s.hands.every((h) => h.outcome === "win"), "split-ace 21 settles as win, NOT blackjack");
  chk(r.room.seats[0].hands.every((h) => h.cards.length === 2 && h.done), "split aces get exactly ONE card each (auto-done)");
  const snap = r.eng._room.snapshot(r.room);
  chk(snap.seats[0].hands.every((h) => h.total === 21 && h.blackjack === false), "snapshot flags split-21 as NOT blackjack (no 3:2 to the client)");
  chk(r.bal === 1200, "split aces both win 1:1 (+200 -> $1200)");
}

console.log("\n== SURRENDER ==");
{ const r = runSolo(P("10S 10D 6H 8C"), ["surrender"]); const s = seat0(r.settle);
  chk(s.hands[0].outcome === "surrender" && s.hands[0].payout === 50, "surrender returns half the bet");
  chk(r.bal === 950, "surrender: -50 -> $950");
  chk(r.room.dealer.length === 2, "surrender-only: dealer does not draw");
}

console.log("\n== INSURANCE ==");
{ // dealer BJ, insured -> wash
  const r = runSolo(P("10S AD 9H KC"), [], { insurance: true });
  const s = seat0(r.settle);
  chk(s.insurance && s.insurance.won && s.insurance.payout === 150, "insurance pays 2:1 on dealer blackjack");
  chk(s.hands[0].outcome === "lose", "main hand loses to dealer blackjack");
  chk(r.bal === 1000, "insured dealer-BJ is a wash (back to $1000)");
}
{ // dealer Ace but NO blackjack, insured -> insurance lost, play continues, main wins
  const r = runSolo(P("10S AD 9H 6C"), ["stand"], { insurance: true });
  const s = seat0(r.settle);
  chk(s.insurance && !s.insurance.won, "insurance lost when dealer has no blackjack");
  chk(s.hands[0].outcome === "win", "play continues after declined dealer BJ; 19 beats soft-17");
  chk(r.bal === 1050, "insurance lost (-50) + main win (+100) = +50 -> $1050");
}
{ // declining insurance still works
  const r = runSolo(P("10S AD 9H 6C"), ["stand"], { insurance: false });
  chk(seat0(r.settle).insurance === null && r.bal === 1100, "decline insurance: just the main win (+100 -> $1100)");
}

console.log("\n== NATURALS / BUST / DAS ==");
{ const r = runSolo(P("AS 9D KH 7C 8H"), []); const s = seat0(r.settle);
  chk(s.hands[0].outcome === "blackjack" && s.hands[0].payout === 250 && r.bal === 1150, "player natural pays 3:2 (+150 -> $1150)");
}
{ const r = runSolo(P("10S 10D 6H 7C 10C"), ["hit"]); const s = seat0(r.settle);
  chk(s.hands[0].outcome === "lose" && r.room.dealer.length === 2, "player bust loses + dealer doesn't draw (all players busted)");
}
{ // double-after-split: split 8s, double both
  const r = runSolo(P("8S 5H 8H 10D 3C 10C 2S 9H 10H"), ["split", "double", "double"]);
  const s = seat0(r.settle);
  chk(s.hands.length === 2 && s.hands.every((h) => h.doubled && h.outcome === "win"), "DAS: both split hands doubled + win");
  chk(r.bal === 1400, "DAS both win: -400 staked +800 -> $1400");
}

console.log("\n== ILLEGAL ACTIONS ==");
{ const r = runSolo(P("10S 9D 7H 8C"), ["split"]); // 10,7 not a pair
  chk(r.sock.last("bj:error") && r.sock.last("bj:error").code === "illegal_action", "split rejected on a non-pair");
  chk(r.room.phase === "turns" && r.room.seats[0].hands.length === 1, "illegal split leaves the hand untouched");
}

console.log("\n== PROVABLY FAIR (real shuffle) ==");
{ const ck = clock(); const eng = BJ.attachBlackjack({ bank: BJ.makeBank(1000), setTimeout: ck.setTimeout, clearTimeout: ck.clearTimeout, timers: { betting: 1e9, turn: 1e9, insurance: 1e9, idle: 1e9, between: 1e9 } });
  const p = sock("p"); eng.handle(p, { type: "bj:room:join", wallet: "p" });
  const room = [...eng._mgr.rooms.values()][0];
  eng.handle(p, { type: "bj:bet:place", amountUsd: 100, clientSeed: "abc" });
  const seeds = room.seats.map((s) => s && s.baseBet > 0 ? s.clientSeed : "");
  const v = S.verify(room.serverSeed, room.commit, seeds, room.shoeId, 6);
  chk(v.hashOk, "commit == SHA256(serverSeed) after a real-shuffle deal");
  chk(JSON.stringify(room.seats[0].hands[0].cards[0]) === JSON.stringify(v.shoe[0]), "dealt card 0 matches the recomputed shoe");
}

console.log("\n== DISCONNECT / LEAVE / ESCROW (audit fixes) ==");
{ // leaving on your own turn must NOT deadlock; the abandoned hand settles on merits
  const ck = clock(); const eng = BJ.attachBlackjack({ bank: BJ.makeBank(1000), setTimeout: ck.setTimeout, clearTimeout: ck.clearTimeout, timers: { betting: 1e9, turn: 1e9, insurance: 1e9, idle: 1e9, between: 1e9 }, makeShoe: () => P("10S 9H 6D 8C 9S 10H 10D") });
  const a = sock("a"), b = sock("b");
  eng.handle(a, { type: "bj:room:join", wallet: "a" }); eng.handle(b, { type: "bj:room:join", wallet: "b" });
  const room = [...eng._mgr.rooms.values()].find((r) => r.seats.filter(Boolean).length === 2);
  eng.handle(a, { type: "bj:bet:place", amountUsd: 100 }); eng.handle(b, { type: "bj:bet:place", amountUsd: 100 });
  chk(room.phase === "turns" && room.turnIdx === 0, "two-player deal -> seat 0 on turn");
  eng.handle(a, { type: "bj:room:leave" }); // A bails ON THEIR TURN
  chk(room.phase === "turns" && room.turnIdx === 1, "leave-on-turn advances to seat 1 (NO deadlock)");
  eng.handle(b, { type: "bj:action", action: "stand" });
  chk(room.phase === "settle", "round settles after the other player acts");
  chk(room.seats[0].hands[0].result && room.seats[0].hands[0].result.outcome === "win", "abandoned 18 settles on merits vs busted dealer = win");
  chk(eng.bank.get("a") === 1100, "leaver still PAID for the winning hand (+100 -> 1100), not forfeited");
  chk(eng.bank.get("b") === 1100, "remaining player paid normally");
  chk(room.seats[0].left === true, "abandoned seat flagged; dropped next startBetting");
}
{ // auto-stand timer firing on a vacated seat must not strand the round (defense-in-depth)
  const ck = clock(); let turnFn = null;
  const ck2 = { setTimeout: (fn, ms) => { const id = ck.setTimeout(fn, ms); return id; }, clearTimeout: ck.clearTimeout };
  const eng = BJ.attachBlackjack({ bank: BJ.makeBank(1000), setTimeout: ck2.setTimeout, clearTimeout: ck2.clearTimeout, timers: { betting: 1e9, turn: 1e9, insurance: 1e9, idle: 1e9, between: 1e9 }, makeShoe: () => P("10S 9H 6D 8C 9S 10H 10D") });
  const a = sock("a"), b = sock("b");
  eng.handle(a, { type: "bj:room:join", wallet: "a" }); eng.handle(b, { type: "bj:room:join", wallet: "b" });
  const room = [...eng._mgr.rooms.values()].find((r) => r.seats.filter(Boolean).length === 2);
  eng.handle(a, { type: "bj:bet:place", amountUsd: 100 }); eng.handle(b, { type: "bj:bet:place", amountUsd: 100 });
  eng.handle(a, { type: "bj:room:leave" });
  chk(room.phase === "turns" && room.turnIdx === 1, "still progresses to seat 1 after leave");
}
{ // insurance LOST + admin closeRoom mid-hand must NOT refund the lost insurance (no minting)
  const ck = clock(); const eng = BJ.attachBlackjack({ bank: BJ.makeBank(1000), setTimeout: ck.setTimeout, clearTimeout: ck.clearTimeout, timers: { betting: 1e9, turn: 1e9, insurance: 1e9, idle: 1e9, between: 1e9 }, makeShoe: () => P("10S AD 9H 5C") });
  const p = sock("p"); eng.handle(p, { type: "bj:room:join", wallet: "p" });
  const room = [...eng._mgr.rooms.values()][0];
  eng.handle(p, { type: "bj:bet:place", amountUsd: 100 });
  eng.handle(p, { type: "bj:insurance", take: true }); // dealer hole 5 -> no BJ -> insurance lost
  chk(room.phase === "turns", "insurance resolved (no dealer BJ) -> turns");
  chk(room.seats[0].insurance === 0, "lost insurance zeroed (no longer in-flight escrow)");
  eng._mgr.closeRoom(room, "admin");
  chk(eng.bank.get("p") === 950, "closeRoom refunds the live bet only (100), NOT the lost insurance -> $950 (no money minted)");
}
{ // one seat per connection across tables
  const ck = clock(); const eng = BJ.attachBlackjack({ bank: BJ.makeBank(1000), setTimeout: ck.setTimeout, clearTimeout: ck.clearTimeout, timers: { betting: 1e9, turn: 1e9, insurance: 1e9, idle: 1e9, between: 1e9 } });
  const p = sock("p"); eng.handle(p, { type: "bj:room:join", wallet: "p" });
  eng.handle(p, { type: "bj:room:join", wallet: "p", roomId: "TABLE-02" });
  const seats = [...eng._mgr.rooms.values()].filter((r) => r.seats.some((s) => s && s.sock === p)).length;
  chk(p.last("bj:error") && p.last("bj:error").code === "already_seated", "second join rejected (one seat per connection across tables)");
  chk(seats === 1, "socket holds exactly one seat");
}

console.log(pass ? "\nALL ACTION TESTS PASSED" : "\n*** SOME TESTS FAILED ***");
if (!pass) process.exitCode = 1;
