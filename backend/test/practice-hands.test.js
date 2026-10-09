import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../../android/app/src/main/assets/www/hands.js',import.meta.url),'utf8');
const context=vm.createContext({});vm.runInContext(source,context);
const bank=JSON.parse(vm.runInContext('JSON.stringify(HAND_BANK)',context));
const pre=['UTG','HJ','CO','BTN','SB','BB'],post=['SB','BB','UTG','HJ','CO','BTN'];
const round=n=>Math.round(n*100)/100;

test('all 50 practice hands have legal sequences, correct pots and legal decision choices',()=>{
  assert.equal(bank.length,50);assert.equal(new Set(bank.map(h=>h.id)).size,50);
  for(const hand of bank){
    const check=(ok,message)=>assert.ok(ok,`${hand.id}: ${message}`);
    const cards=[...hand.heroHand,...hand.board];
    check(cards.every(c=>/^[2-9TJQKA][shdc]$/.test(c)),'valid cards');
    check(new Set(cards).size===cards.length,'no duplicate cards');
    check(hand.heroHand.length===2,'two hole cards');
    check(hand.board.length===({Preflop:0,Flop:3,Turn:4,River:5})[hand.street],'board matches street');
    check(pre.includes(hand.heroPos)&&pre.includes(hand.villainPos)&&hand.heroPos!==hand.villainPos,'distinct valid seats');
    let alive=new Set(pre),total=Object.fromEntries(pre.map(p=>[p,0])),pot=0,lastStreet='',pending=[],paid={},highest=0,minRaise=1;
    for(const action of hand.actions){
      const {street,position,action:kind,toBb}=action;
      if(street!==lastStreet){
        if(lastStreet)check(pending.length===0,'earlier street completed before next card');
        const order=street==='preflop'?pre:post;
        pending=order.filter(p=>alive.has(p));paid=Object.fromEntries(pre.map(p=>[p,0]));highest=0;minRaise=1;lastStreet=street;
      }
      check(alive.has(position),'folded players cannot act');
      if(kind==='post'){check(street==='preflop'&&['SB','BB'].includes(position),'blind post');}
      else{
        check(position===pending[0],`correct turn order: ${position} ${kind}, expected ${pending[0]}`);
        pending.shift();
        if(kind==='fold'){check(paid[position]<highest,'fold only when facing a wager');alive.delete(position);}
        if(kind==='check')check(paid[position]===highest,'cannot check facing a wager');
        if(kind==='call')check(toBb===highest&&toBb>paid[position],'call matches outstanding wager');
        if(kind==='bet')check(highest===0&&toBb>=1,'opening bet');
        if(kind==='raise')check(highest>0&&round(toBb-highest)>=minRaise,'legal minimum raise');
        if(['bet','raise'].includes(kind)){
          minRaise=round(toBb-highest);const order=street==='preflop'?pre:post,i=order.indexOf(position);
          pending=[...order.slice(i+1),...order.slice(0,i)].filter(p=>alive.has(p));
        }
      }
      if(toBb!==undefined){const added=round(toBb-paid[position]);check(added>=0,'nonnegative wager');paid[position]=toBb;total[position]=round(total[position]+added);pot=round(pot+added);highest=Math.max(highest,toBb);check(total[position]<=hand.startingStackBb,'stack covers every wager');}
    }
    if(lastStreet!==hand.street.toLowerCase()){
      check(pending.length===0,'prior street ended before hero starts next street');
      pending=post.filter(p=>alive.has(p));paid=Object.fromEntries(pre.map(p=>[p,0]));highest=0;minRaise=1;
    }
    check(pending[0]===hand.heroPos,`hero is next to act, got ${pending[0]}`);
    check(round(pot)===hand.potBb,'displayed pot includes every contribution');
    const due=round(highest-paid[hand.heroPos]),stack=round(hand.startingStackBb-total[hand.heroPos]);
    check(due===hand.toCallBb&&stack===hand.heroStackBb,'call amount and stack match history');
    for(const choice of hand.choices){
      check(choice.amountBb<=stack,'choice fits remaining stack');
      if(choice.action==='fold'||choice.action==='call')check(due>0,'fold/call only facing a bet');
      if(choice.action==='check'||choice.action==='bet')check(due===0,'check/bet only when no wager outstanding');
      if(choice.action==='raise')check(due>0&&round(choice.toBb-highest)>=minRaise,'legal raise choice');
      if(choice.action==='allin')check(choice.amountBb===stack,'all-in uses remaining chips');
    }
  }
});

test('previously inconsistent spots include dead blinds and completed earlier streets',()=>{
  const get=id=>bank.find(h=>h.id===id);
  assert.equal(get('H06').potBb,4);assert.equal(get('H18').potBb,4);
  assert.equal(get('H10').potBb,13.5);assert.equal(get('H11').potBb,13);
  assert.equal(get('H41').potBb,5.5); // A checked-through flop cannot inflate the turn pot.
  assert.equal(get('H30').toCallBb,3.96);assert.equal(get('H30').potBb,9.96);
  assert.doesNotMatch(source,/missed draw/); // H45 makes a straight on the river.
});
