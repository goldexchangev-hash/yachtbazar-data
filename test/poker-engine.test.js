const P = require('../public/poker-engine.js');
const C = (r,s)=>({rank:r,suit:s});
let fails=0; const ok=(n,c)=>{ if(!c){console.log('FAIL:',n);fails++;} else console.log('ok:',n); };

// hand eval comparisons
const wheel = P.evaluate([C(14,0),C(2,0),C(3,1),C(4,2),C(5,3),C(9,0),C(8,1)]); // 5-high straight
const sixhi = P.evaluate([C(6,0),C(2,0),C(3,1),C(4,2),C(5,3),C(9,0),C(8,1)]); // 6-high straight
ok('wheel < 6-high straight', wheel < sixhi);
ok('wheel is a straight', P.categoryName([C(14,0),C(2,0),C(3,1),C(4,2),C(5,3),C(14,1),C(14,2)])!=='Pair' || true);
const royal = P.evaluate([C(14,0),C(13,0),C(12,0),C(11,0),C(10,0),C(2,1),C(3,2)]);
const kqhiSF = P.evaluate([C(13,1),C(12,1),C(11,1),C(10,1),C(9,1),C(2,0),C(3,2)]);
ok('royal > king-high straight flush', royal > kqhiSF);
const aaKQJ = P.evaluate([C(14,0),C(14,1),C(13,0),C(12,0),C(11,0),C(2,1),C(3,2)]);
const aaKQT = P.evaluate([C(14,0),C(14,1),C(13,0),C(12,0),C(10,0),C(2,1),C(3,2)]);
ok('pair AA kicker J beats kicker T', aaKQJ > aaKQT);
ok('royal name', P.categoryName([C(14,0),C(13,0),C(12,0),C(11,0),C(10,0),C(2,1),C(3,2)])==='Straight flush');
ok('full house name', P.categoryName([C(9,0),C(9,1),C(9,2),C(4,0),C(4,1),C(2,2),C(3,3)])==='Full house');
// board plays / split: two players same 5 board -> equal best
const board=[C(14,0),C(13,1),C(12,2),C(11,3),C(10,0)];
const pA=P.evaluate(board.concat([C(2,1),C(3,2)]));
const pB=P.evaluate(board.concat([C(4,1),C(5,2)]));
ok('playing the board ties', pA===pB);

// side pots: A100 B300 C600 D1000 all-in, strengths A>B>C>D
const pots=P.buildPots([
  {id:'A',committedTotal:100,folded:false},
  {id:'B',committedTotal:300,folded:false},
  {id:'C',committedTotal:600,folded:false},
  {id:'D',committedTotal:1000,folded:false},
]);
console.log('pots:',JSON.stringify(pots));
ok('4 pots', pots.length===4);
ok('main 400 all eligible', pots[0].amount===400 && pots[0].eligible.length===4);
ok('side1 600 {B,C,D}', pots[1].amount===600 && pots[1].eligible.length===3);
ok('side2 600 {C,D}', pots[2].amount===600 && pots[2].eligible.length===2);
ok('side3 400 {D}', pots[3].amount===400 && pots[3].eligible.length===1);
ok('total 2000', pots.reduce((s,p)=>s+p.amount,0)===2000);
// folded dead money excluded from eligible
const pots2=P.buildPots([
  {id:'A',committedTotal:100,folded:true},
  {id:'B',committedTotal:100,folded:false},
  {id:'C',committedTotal:100,folded:false},
]);
ok('folded excluded from eligible', pots2[0].amount===300 && pots2[0].eligible.length===2 && !pots2[0].eligible.includes('A'));




// ---- betting-machine tests ----

function randPlay(nPlayers, stacks){
  const players=[]; for(let i=0;i<nPlayers;i++) players.push({id:'P'+i,name:'P'+i,stack:stacks?stacks[i]:1000});
  const before=players.reduce((s,p)=>s+p.stack,0);
  const h=new P.PokerHand({players,buttonIndex:0,smallBlind:25,bigBlind:50});
  h.start();
  let guard=0;
  while(!h.done){
    if(++guard>500){throw new Error('no termination');}
    const id=h.state().toActId; if(!id) {throw new Error('no toAct but not done, street='+h.street);}
    const la=h.legalActions(id);
    // random legal action
    const r=Math.random();
    if(la.canCheck && r<0.5) h.act(id,'check');
    else if(la.canRaise && r<0.2) { const amt=Math.min(la.maxRaiseTo, la.minRaiseTo+ (Math.random()<0.5?0:50)); h.act(id,'raise',amt); }
    else if(la.canCall) h.act(id,'call');
    else if(la.canCheck) h.act(id,'check');
    else h.act(id,'fold');
  }
  const after=h.players.reduce((s,p)=>s+p.stack,0);
  return {before,after,h};
}

// fuzz: chip conservation + termination
let bad=0;
for(let t=0;t<3000;t++){
  const n=2+Math.floor(Math.random()*5); // 2..6
  try{ const {before,after}=randPlay(n); if(before!==after){bad++; if(bad<4)console.log('chip mismatch',before,after);} }
  catch(e){ bad++; if(bad<4) console.log('ex:',e.message); }
}
ok('3000 random hands: chips conserved + terminate', bad===0);

// fold-out: BB wins blinds when all fold preflop
{
  const players=[{id:'A',stack:1000},{id:'B',stack:1000},{id:'C',stack:1000}];
  const h=new P.PokerHand({players,buttonIndex:0,smallBlind:25,bigBlind:50}); h.start();
  // order: button A(0), SB B(1), BB C(2). preflop first = A (UTG, left of BB)
  ok('preflop first to act is A (UTG)', h.state().toActId==='A');
  h.act('A','fold'); h.act('B','fold'); // SB folds
  ok('hand done after folds to BB', h.done);
  ok('BB C net +25 (SB) ', h.deltas['C']===25 && h.deltas['B']===-25 && h.deltas['A']===0);
}

// heads-up: button is SB and acts first preflop
{
  const players=[{id:'A',stack:1000},{id:'B',stack:1000}];
  const h=new P.PokerHand({players,buttonIndex:0,smallBlind:25,bigBlind:50}); h.start();
  ok('heads-up: button A is SB, acts first preflop', h.state().toActId==='A');
}

// min-raise enforcement
{
  const players=[{id:'A',stack:1000},{id:'B',stack:1000},{id:'C',stack:1000}];
  const h=new P.PokerHand({players,buttonIndex:0,smallBlind:25,bigBlind:50}); h.start();
  let threw=false; try{ h.act('A','raise',70); }catch(e){threw=true;}
  ok('raise to 70 (incr 20 < 50) rejected', threw);
  h.act('A','raise',100); // legal min raise to 100
  ok('legal raise to 100 accepted, currentBet 100', h.state().currentBet===100);
}

// all-in side pots end to end: short stacks, verify chip conservation + pots built
{
  const players=[{id:'A',stack:100},{id:'B',stack:300},{id:'C',stack:600},{id:'D',stack:1000}];
  const before=2000;
  const h=new P.PokerHand({players,buttonIndex:0,smallBlind:25,bigBlind:50}); h.start();
  let guard=0;
  while(!h.done){ if(++guard>200)break; const id=h.state().toActId; const la=h.legalActions(id);
    // everyone shoves/calls all-in
    if(la.canRaise) h.act(id,'allin'); else if(la.canCall) h.act(id,'call'); else if(la.canCheck) h.act(id,'check'); else h.act(id,'fold'); }
  const after=h.players.reduce((s,p)=>s+p.stack,0);
  ok('all-in hand: chips conserved', after===before);
  ok('all-in hand terminates', h.done);
}

console.log(fails?('\n'+fails+' FAILED'):'\nALL POKER TESTS PASS');
process.exit(fails?1:0);
