function normalizePosition(position=""){
  const p=String(position||"").toUpperCase().replace("BUTTON","BTN").replace("BIG BLIND","BB").replace("SMALL BLIND","SB").trim();
  return p==="HJ" ? "MP" : p;
}

function roundBb(value){
  const n=Number(value);
  return Number.isFinite(n)?Math.round(n*1000)/1000:0;
}

function addAmount(map,key,delta){
  const k=normalizePosition(key);
  map[k]=roundBb((map[k]||0)+(Number(delta)||0));
}

function applyPokerAction(state,action){
  const pos=normalizePosition(action.position);
  const invested=Number(state.invested[pos]||0);
  state.invested[pos]=invested;
  const highest=Math.max(0,...Object.values(state.invested).map(Number));
  const amount=Math.max(0,Number(action.amountBb)||0);
  let delta=0;
  if(action.action==="small_blind"||action.action==="big_blind"){
    delta=Math.max(0,amount-invested);
  }else if(action.action==="call"){
    const need=Math.max(0,highest-invested);
    // Calls are encoded as ADDITIONAL chips called. A short all-in call can be
    // smaller than need; never inflate it to the full outstanding amount.
    delta=amount>0?Math.min(amount,need):need;
  }else if(action.action==="bet"||action.action==="donk_bet"){
    delta=Math.max(0,amount-invested);
  }else if(action.action==="raise"||action.action==="allin"){
    delta=Math.max(0,amount-invested);
  }
  const potBefore=state.pot;
  if(delta>0){
    state.invested[pos]=roundBb(invested+delta);
    state.pot=roundBb(state.pot+delta);
    addAmount(state.totalByPos,pos,delta);
  }
  return {delta:roundBb(delta),potBefore:roundBb(potBefore),potAfter:roundBb(state.pot),callAmount:Math.max(0,highest-invested),raiseAmount:Math.max(0,amount-highest)};
}

function visibleStreetPot(spot,street){
  const n=Number(spot.streetStartPotsBb?.[street]);
  return Number.isFinite(n)&&n>0?n:0;
}

function reconstructSolverMath(spot){
  const notes=[...(spot.extractionNotes||[])];
  const issues=[];
  const derivedMissing=new Set(["effectiveStackBb","potAtDecisionBb","heroStackBb","villainStackBb","flopStartPotBb","flopStartEffectiveStackBb"]);
  spot.missingFields=(spot.missingFields||[]).filter(x=>!derivedMissing.has(String(x)));

  const streets=["preflop","flop","turn","river"];
  const decisionIndex=streets.indexOf(spot.decisionStreet);
  const state={pot:0,invested:{},totalByPos:{}};
  const streetSnapshots={};
  const rewritten=[];

  for(let si=0;si<streets.length;si++){
    const street=streets[si];
    if(decisionIndex>=0 && si>decisionIndex)break;
    state.invested={};
    const visible=visibleStreetPot(spot,street);

    if(street==="preflop"){
      state.pot=0;
    }else if(visible>0){
      const computedStart=state.pot;
      const tolerance=Math.max(.35,visible*.025);
      if(Math.abs(computedStart-visible)>tolerance){
        issues.push(`${street}: displayed start pot ${visible} BB does not reconcile with prior actions (computed ${roundBb(computedStart)} BB)`);
      }
      // The street header is a reliable visual anchor in supported replayers.
      state.pot=visible;
    }

    streetSnapshots[street]={startPot:roundBb(state.pot),startTotals:{...state.totalByPos}};
    const actions=(spot.actionHistory||[]).filter(a=>a.street===street);
    for(const source of actions){
      const a={...source,position:normalizePosition(source.position),action:source.action==="donk_bet"?"bet":source.action};
      const result=applyPokerAction(state,a);
      if(["bet","raise","allin"].includes(a.action)&&result.potBefore>0){
        // Pokerai sizes raises by the increment ABOVE the outstanding wager,
        // divided by the pot AFTER calling, not all chips added / current pot.
        a.sizePctPot=result.callAmount>0?
          roundBb(result.raiseAmount/(result.potBefore+result.callAmount)*100):
          roundBb(result.delta/result.potBefore*100);
      }else if(!["bet","raise","allin"].includes(a.action)){
        a.sizePctPot=0;
      }
      rewritten.push(a);
    }
    streetSnapshots[street].endPot=roundBb(state.pot);
    streetSnapshots[street].endTotals={...state.totalByPos};
  }

  spot.actionHistory=rewritten;
  if(streetSnapshots[spot.decisionStreet])spot.potAtDecisionBb=roundBb(state.pot);
  if(streetSnapshots.flop)spot.flopStartPotBb=roundBb(streetSnapshots.flop.startPot);

  const hero=normalizePosition(spot.heroPosition);
  const villain=normalizePosition(spot.villainPosition);
  const totalsBefore={...state.totalByPos};
  const decisionStreetInvested={...state.invested};
  const decisionStreetActions=(spot.actionHistory||[]).filter(a=>a.street===spot.decisionStreet);

  let observedDelta=0;
  let uncalledReturn=0;
  let finalPotFromActions=state.pot;
  const fullState={pot:state.pot,invested:{...decisionStreetInvested},totalByPos:{...state.totalByPos}};

  function returnUncalled(action){
    if(!["call","fold"].includes(action.action))return;
    const contributions=Object.entries(fullState.invested).sort((a,b)=>b[1]-a[1]);
    if(contributions.length<2)return;
    const [position,amount]=contributions[0];
    const excess=roundBb(amount-contributions[1][1]);
    if(excess<=0)return;
    fullState.pot=roundBb(fullState.pot-excess);
    fullState.invested[position]=roundBb(amount-excess);
    fullState.totalByPos[position]=roundBb(fullState.totalByPos[position]-excess);
    uncalledReturn=roundBb(uncalledReturn+excess);
    notes.push(`Uncalled excess reconstructed: ${excess} BB returned to ${position}`);
  }

  if(spot.observedHeroAction && spot.observedHeroAction!=="unknown" && hero){
    const synthetic={
      street:spot.decisionStreet,
      position:hero,
      action:spot.observedHeroAction,
      amountBb:Number(spot.observedHeroAmountBb)||0,
      sizePctPot:0
    };

    if(synthetic.action==="call" && synthetic.amountBb<=0){
      const highest=Math.max(0,...Object.values(fullState.invested).map(Number));
      synthetic.amountBb=Math.max(0,highest-Number(fullState.invested[hero]||0));
    }

    const observedResult=applyPokerAction(fullState,synthetic);
    observedDelta=observedResult.delta;
    returnUncalled(synthetic);

    let lastStreet=spot.decisionStreet;
    let lastStreetActions=[...decisionStreetActions,synthetic];
    for(const action of spot.actionHistoryAfterDecision||[]){
      if(action.street!==lastStreet){
        if(streets.indexOf(action.street)<streets.indexOf(lastStreet)){
          issues.push("Actions after Hero's decision are out of street order");
          break;
        }
        fullState.invested={};
        lastStreetActions=[];
        lastStreet=action.street;
      }
      if(action.action==="unknown")issues.push("Actions after Hero's decision contain an unknown action");
      applyPokerAction(fullState,action);
      returnUncalled(action);
      lastStreetActions.push(action);
    }
    finalPotFromActions=roundBb(fullState.pot);
    const lastAction=lastStreetActions.at(-1)?.action;
    const bettingComplete=lastAction==="fold" || (lastStreet==="river" &&
      (lastAction==="call" || lastStreetActions.slice(-2).every(a=>a.action==="check")&&lastStreetActions.length>=2));
    if(Number(spot.finalPotBb)>0&&bettingComplete){
      const tolerance=Math.max(.5,Number(spot.finalPotBb)*.015);
      if(Math.abs(finalPotFromActions-Number(spot.finalPotBb))>tolerance){
        issues.push(`Final pot does not reconcile: displayed ${spot.finalPotBb} BB vs ${roundBb(finalPotFromActions)} BB from the action history`);
      }else{
        notes.push(`Final pot verified: ${roundBb(finalPotFromActions)} BB`);
      }
    }else if(Number(spot.finalPotBb)>0){
      notes.push("Final pot validation needs the remaining betting actions after Hero's decision.");
    }
  }

  const heroDisplayed=Number(spot.heroDisplayedStackBb)||0;
  const villainDisplayed=Number(spot.villainDisplayedStackBb)||0;
  let heroStart=0,villainStart=0;

  if(spot.displayedStacksTiming==="after_decision_before_pot_award"){
    heroStart=heroDisplayed+Number(fullState.totalByPos[hero]||0);
    villainStart=villainDisplayed+Number(fullState.totalByPos[villain]||0);
  }else if(spot.displayedStacksTiming==="before_decision"){
    heroStart=heroDisplayed+Number(totalsBefore[hero]||0);
    villainStart=villainDisplayed+Number(totalsBefore[villain]||0);
  }

  // Completed-hand replayers often show Hero as 0 after an all-in. Hero's
  // starting stack is still exactly recoverable from visible contributions.
  if(heroStart<=0 && observedDelta>0 && spot.observedHeroAction==="allin"){
    heroStart=Number(totalsBefore[hero]||0)+observedDelta;
  }

  if(heroStart>0&&villainStart>0){
    const preflopEnd=streetSnapshots.preflop?.endTotals||{};
    const heroFlopBehind=Math.max(0,heroStart-Number(preflopEnd[hero]||0));
    const villainFlopBehind=Math.max(0,villainStart-Number(preflopEnd[villain]||0));
    const effFlop=Math.min(heroFlopBehind,villainFlopBehind);
    if(effFlop>0){
      spot.flopStartEffectiveStackBb=roundBb(effFlop);
      notes.push(`Effective stack entering flop reconstructed: ${roundBb(effFlop)} BB`);
    }

    const heroBeforeDecision=Math.max(0,heroStart-Number(totalsBefore[hero]||0));
    const villainAfterWager=Math.max(0,villainStart-Number(totalsBefore[villain]||0));
    spot.heroStackBb=roundBb(heroBeforeDecision);
    spot.villainStackBb=roundBb(villainAfterWager);
    spot.effectiveStackBb=roundBb(heroBeforeDecision);
  }

  if(streetSnapshots[spot.decisionStreet]){
    notes.push(`Pot at Hero decision reconstructed: ${roundBb(spot.potAtDecisionBb)} BB`);
  }
  for(const street of ["flop","turn","river"]){
    const visible=visibleStreetPot(spot,street);
    if(visible>0)notes.push(`${street[0].toUpperCase()+street.slice(1)} starts at ${visible} BB`);
  }

  spot.extractionNotes=[...new Set(notes)];
  if(issues.length){
    spot.actionHistoryComplete=false;
    spot.missingFields=[...(spot.missingFields||[]),...issues];
  }

  return {
    spot,
    issues,
    streetSnapshots,
    finalPotFromActions:roundBb(finalPotFromActions),
    uncalledReturnBb:roundBb(uncalledReturn),
    heroStartBb:roundBb(heroStart),
    villainStartBb:roundBb(villainStart)
  };
}

export { normalizePosition, roundBb, addAmount, applyPokerAction, visibleStreetPot, reconstructSolverMath };
