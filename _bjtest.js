const { attachBlackjack } = require("./server/blackjack-server.js");

// SYNCHRONOUS timers so we can drive a full hand deterministically.
const bj = attachBlackjack({ startBalance: 16000, timers: { betting: 999999, turn: 999999, insurance: 999999, between: 999999, dealReveal:0, dealPace:0, dealerReveal:0, dealerPace:0 } });

function mkSock(name){ const s = { wallet: "guest:"+name, sent: [], send(j){ this.sent.push(JSON.parse(j)); } }; return s; }
const sock = mkSock("alice");
bj.handle(sock, { type:"bj:room:join", wallet:"guest:alice" });
const rooms = bj._mgr.rooms;
let room = [...rooms.values()].find(r=> r.seats.some(s=>s&&s.wallet==="guest:alice"));
console.log("joined", room.id, "phase", room.phase, "bal", bj.bank.get("guest:alice"));
bj.handle(sock, { type:"bj:bet:place", amountUsd: 16000, clientSeed:"abc" });
console.log("after bet: phase", room.phase, "bal", bj.bank.get("guest:alice"));

// Drive many hands, hitting until done, to exercise hit->settle repeatedly.
function playSeat(){
  let guard=0;
  while(room.phase==="turns" && room.turnIdx>=0 && guard++<50){
    bj.handle(sock, { type:"bj:action", action:"hit" });
  }
}
let hands=0, crash=null;
try{
  for(let n=0;n<2000;n++){
    if(room.phase==="betting"){ bj.handle(sock,{type:"bj:bet:place",amountUsd:Math.max(10,Math.min(16000,bj.bank.get("guest:alice"))),clientSeed:"s"+n}); }
    if(room.phase==="insurance"){ bj.handle(sock,{type:"bj:insurance",take:false}); }
    if(room.phase==="turns"){ playSeat(); }
    if(room.phase==="settle"){ /* sync between fires immediately->startBetting */ }
    if(bj.bank.get("guest:alice")<10){ bj.bank.all.set("guest:alice",16000); }
    hands++;
  }
}catch(e){ crash=e; }
console.log("hands driven:", hands, "crash:", crash? (crash.message+"\n"+crash.stack):"NONE");
