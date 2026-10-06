import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV="test";
process.env.OPENAI_API_KEY=process.env.OPENAI_API_KEY||"test-key";

const {
  expectedPostflopSegments,
  pokeraiPreflopActions,
  preflopRangeReadinessIssues,
  reconstructSolverMath,
  solverSpotInputSchema
}=await import("../src/server.js");

test("preflop adapter sends incremental PokerAI amounts",()=>{
  const rows=[
    {street:"preflop",position:"SB",action:"small_blind",amountBb:.5,sizePctPot:0},
    {street:"preflop",position:"BB",action:"big_blind",amountBb:1,sizePctPot:0},
    {street:"preflop",position:"UTG",action:"raise",amountBb:2,sizePctPot:0},
    {street:"preflop",position:"CO",action:"raise",amountBb:7,sizePctPot:0},
    {street:"preflop",position:"UTG",action:"raise",amountBb:16.5,sizePctPot:0},
    {street:"preflop",position:"CO",action:"call",amountBb:9.5,sizePctPot:0}
  ];
  const mapped=pokeraiPreflopActions(rows);
  assert.deepEqual(mapped.map(x=>x.amount),[.5,1,2,7,14.5,9.5]);
  assert.equal(mapped[4].action,"raise");
});

test("short river all-in call returns unmatched chips before final-pot validation",()=>{
  const spot={
    decisionStreet:"river",
    heroPosition:"BTN",
    villainPosition:"BB",
    streetStartPotsBb:{preflop:0,flop:0,turn:0,river:90},
    actionHistory:[
      {street:"river",position:"BB",action:"bet",amountBb:95.375,sizePctPot:0}
    ],
    observedHeroAction:"call",
    observedHeroAmountBb:58.95,
    heroDisplayedStackBb:0,
    villainDisplayedStackBb:0,
    displayedStacksTiming:"unknown",
    finalPotBb:207.9,
    missingFields:[],
    extractionNotes:[],
    actionHistoryComplete:true
  };
  const result=reconstructSolverMath(spot);
  assert.equal(result.uncalledReturnBb,36.425);
  assert.equal(result.finalPotFromActions,207.9);
  assert.equal(result.issues.some(x=>x.includes("Final pot does not reconcile")),false);
});

test("open all-in is a BET while an all-in facing a bet is a RAISE",()=>{
  const open=expectedPostflopSegments({
    board:["As","Kd","7c"],
    decisionStreet:"flop",
    actionHistory:[{street:"flop",position:"UTG",action:"allin",amountBb:20,sizePctPot:100}]
  });
  assert.equal(open[0].type,"BET");

  const facing=expectedPostflopSegments({
    board:["As","Kd","7c"],
    decisionStreet:"flop",
    actionHistory:[
      {street:"flop",position:"UTG",action:"bet",amountBb:8,sizePctPot:50},
      {street:"flop",position:"CO",action:"allin",amountBb:30,sizePctPot:150}
    ]
  });
  assert.deepEqual(facing.map(x=>x.type),["BET","RAISE"]);
});

test("solver request parser coerces numeric form values instead of throwing 500",()=>{
  const parsed=solverSpotInputSchema.safeParse({
    confidence:"0.99",
    game:"NLH",
    format:"cash",
    tableSize:"6",
    heroPosition:"CO",
    villainPosition:"UTG",
    heroRole:"IP",
    heroCards:["Ah","Qh"],
    board:["Ad","Ts","8c","5h","Jd"],
    decisionStreet:"river",
    effectiveStackBb:"128.79",
    potAtDecisionBb:"161.46",
    heroStackBb:"128.79",
    villainStackBb:"128.79",
    flopStartPotBb:"34.5",
    flopStartEffectiveStackBb:"156.39",
    actionHistoryComplete:true,
    observedHeroAction:"raise",
    observedHeroAmountBb:"128.79",
    heroDisplayedStackBb:"0",
    villainDisplayedStackBb:"72.38",
    displayedStacksTiming:"after_decision_before_pot_award",
    finalPotBb:"347.28",
    streetStartPotsBb:{preflop:"1.5",flop:"34.5",turn:"34.5",river:"89.7"},
    actionHistory:[],
    missingFields:[],
    extractionNotes:[]
  });
  assert.equal(parsed.success,true);
  assert.equal(parsed.data.flopStartPotBb,34.5);
  assert.equal(parsed.data.tableSize,6);
});

test("postflop readiness catches missing range actions before calling provider",()=>{
  const issues=preflopRangeReadinessIssues({
    decisionStreet:"river",
    heroPosition:"CO",
    villainPosition:"UTG",
    actionHistory:[
      {street:"preflop",position:"CO",action:"call",amountBb:2,sizePctPot:0}
    ]
  });
  assert.deepEqual(issues,["Missing final preflop action for UTG"]);
});
