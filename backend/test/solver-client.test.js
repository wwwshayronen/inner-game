import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { reconstructSolverMath } from "../src/solver-math.js";

const source = readFileSync(new URL("../../android/app/src/main/assets/www/app.js", import.meta.url), "utf8");

function appContext(fetch) {
  let elapsed = 0;
  class Clock extends Date { static now() { return elapsed; } }
  const hand = { id: "hand-105496", imageKey: "image" };
  const context = vm.createContext({
    window: {}, localStorage: { getItem: () => null, setItem: () => {} },
    structuredClone, AbortSignal, Date: Clock, hand, fetch,
    setTimeout: (callback, ms) => { elapsed += ms; queueMicrotask(callback); return 0; }
  });
  // Load the complete app definitions, leaving DOM startup to the real browser.
  const startup = source.lastIndexOf("\nsave();\n");
  assert.ok(startup > 0);
  vm.runInContext(source.slice(0, startup), context);
  vm.runInContext(`
    state.generalHands.push(hand);
    getHandImage=async()=>"data:image/jpeg;base64,test";
    render=()=>{}; save=()=>{}; solverDebugAdd=()=>{};
  `, context);
  return { context, hand, elapsed: () => elapsed };
}

function enableDebug(context){
  vm.runInContext(source.slice(source.indexOf('function solverDebugValue('),source.indexOf('function solverDebugText(')),context);
}

test('API debug preserves JSON errors and non-JSON server bodies without consuming the response',async()=>{
  let count=0;
  const {context,hand}=appContext(async()=>++count===1?
    Response.json({error:'invalid_spot',validation:[{path:'board',message:'Missing card'}]},{status:422}):
    new Response('<html>Gateway unavailable</html>',{status:502}));
  enableDebug(context);
  context.options={method:'POST',body:JSON.stringify({spot:{heroCards:['Kc','Qd']}})};
  const first=await vm.runInContext("solverFetch(hand,'https://api.example/solver/solve',options)",context);
  assert.equal((await first.json()).validation[0].path,'board');
  const second=await vm.runInContext("solverFetch(hand,'https://api.example/solver/poll',options)",context);
  assert.equal(await second.text(),'<html>Gateway unavailable</html>');
  assert.equal(hand.solverDebug[0].data.status,422);
  assert.deepEqual(JSON.parse(JSON.stringify(hand.solverDebug[0].data.request)),{spot:{heroCards:['Kc','Qd']}});
  assert.equal(hand.solverDebug[1].data.response,'<html>Gateway unavailable</html>');
  const panel=vm.runInContext('solverHttpPanel(hand)',context);
  assert.match(panel,/HTTP 422/);assert.match(panel,/&lt;html&gt;/);assert.doesNotMatch(panel,/<html>/);
});

test('API debug records offline errors and omits screenshot data',async()=>{
  const {context,hand}=appContext(async()=>{throw new Error('Network unavailable');});
  enableDebug(context);
  context.options={method:'POST',body:JSON.stringify({imageDataUrl:'data:image/jpeg;base64,private-image',hand:{heroCards:['Kc','Qd']}})};
  await assert.rejects(vm.runInContext("solverFetch(hand,'https://api.example/solver/inspect',options)",context),/Network unavailable/);
  assert.equal(hand.solverDebug[0].data.status,0);
  assert.equal(hand.solverDebug[0].data.request.imageDataUrl,'[omitted]');
  assert.equal(hand.solverDebug[0].data.error,'Network unavailable');
  assert.doesNotMatch(JSON.stringify(hand.solverDebug),/private-image/);
});

test('API debug marks oversized bodies while retaining HTTP metadata',async()=>{
  const {context,hand}=appContext(async()=>Response.json({large:'x'.repeat(40000)}));
  enableDebug(context);context.options={method:'POST',body:'{}'};
  await vm.runInContext("solverFetch(hand,'https://api.example/solver/poll',options)",context);
  assert.equal(hand.solverDebug[0].data.status,200);
  assert.equal(hand.solverDebug[0].data.response.truncated,true);
  assert.ok(hand.solverDebug[0].data.response.preview.length<=32000);
});

test("mobile waits past the old 60-second request window using short inspection polls", async () => {
  const calls = [];
  const { context, hand, elapsed } = appContext(async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    if (calls.length === 1) return Response.json({ status: "pending", inspectionId: "read-1" }, { status: 202 });
    if (calls.length < 72) return Response.json({ status: "pending" }, { status: 202 });
    return Response.json({ spot: { heroCards: ["Ah", "Qh"] }, ready: true });
  });
  await vm.runInContext("inspectHandForSolver(hand.id, true)", context);
  assert.ok(elapsed() > 60_000);
  assert.equal(calls[0].body.async, true);
  assert.ok(calls.slice(1).every(call => call.url.endsWith("/solver/inspect/poll") && call.body.inspectionId === "read-1"));
  assert.deepEqual(hand.solverSpot.heroCards, ["Ah", "Qh"]);
  assert.equal(hand.solverSpotVersion, 7);
  assert.equal(hand.solverError, "");
});

test("mobile retries a dropped inspection poll without starting another image read", async () => {
  let calls = 0;
  const { context, hand } = appContext(async () => {
    calls++;
    if (calls === 1) return Response.json({ status: "pending", inspectionId: "read-1" }, { status: 202 });
    if (calls === 2) throw new Error("Network dropped");
    return Response.json({ spot: { heroCards: ["Ah", "Qh"] }, ready: true });
  });
  await vm.runInContext("inspectHandForSolver(hand.id, true)", context);
  assert.equal(calls, 3);
  assert.equal(hand.solverSpotVersion, 7);
  assert.equal(hand.solverError, "");
});

test("mobile displays an extraction failure instead of saving empty details", async () => {
  let calls = 0;
  const { context, hand } = appContext(async () => {
    calls++;
    if (calls === 1) return Response.json({ status: "pending", inspectionId: "read-1" }, { status: 202 });
    return Response.json({ error: "solver_extract_invalid_json", message: "Could not read this image." }, { status: 502 });
  });
  await vm.runInContext("inspectHandForSolver(hand.id, true)", context);
  assert.equal(calls, 2);
  assert.equal(hand.solverSpot, undefined);
  assert.equal(hand.solverError, "Could not read this image.");
});

test("mobile accepts an opening shove while rejecting a raise without a bet", () => {
  const { context } = appContext(async () => {});
  context.spot = {
    decisionStreet: "flop", heroPosition: "CO", villainPosition: "UTG",
    actionHistory: [
      { street: "preflop", position: "SB", action: "small_blind" },
      { street: "preflop", position: "BB", action: "big_blind" },
      { street: "flop", position: "UTG", action: "allin" }
    ]
  };
  assert.equal(vm.runInContext("solverLocalHistoryIssues(spot).length", context), 0);
  context.spot.actionHistory.at(-1).action = "raise";
  assert.equal(vm.runInContext("solverLocalHistoryIssues(spot).length", context), 1);
});

test("saved raw EVs use fold as zero and missing EVs are not invented",()=>{
  const {context}=appContext(async()=>{});
  context.solution={evs:{actions:["CALL","FOLD","RAISE 20"],values:[-59.00813293457031,-45.249996185302734,null]}};
  const display=vm.runInContext("solverEvDisplay(solution)",context);
  assert.equal(display.decision,true);assert.equal(display.values[1],0);assert.equal(display.values[2],null);
  assert.equal(vm.runInContext("solverEvNumber(null)",context),null);
  context.solution={evs:{actions:["CHECK","BET 5","BET 15","BET 40"],values:[-7.475,-8.668,-8.319,-10.125]}};
  const raw=vm.runInContext("solverEvDisplay(solution)",context);
  assert.equal(raw.decision,false);assert.equal(raw.losses[0],0);
  assert.ok(Math.abs(raw.losses[1]-1.193)<1e-9);
});

test("a saved check result is incompatible with QQ facing the river bet",()=>{
  const {context}=appContext(async()=>{});
  context.spot=JSON.parse(readFileSync(new URL("fixtures/105296.json",import.meta.url)));
  context.solution={street:"river",strategy:[{action:"check",frequency:.95}]};
  assert.equal(vm.runInContext("solverResultMatchesSpot(solution,spot)",context),false);
  context.solution.strategy=[{action:"fold",frequency:.5},{action:"call",frequency:.5}];
  assert.equal(vm.runInContext("solverResultMatchesSpot(solution,spot)",context),true);
});

test("a re-solve clears the old result immediately and duplicate taps do not schedule another solve",async()=>{
  let finish,calls=0;
  const {context,hand}=appContext(()=>{calls++;return new Promise(resolve=>{finish=resolve});});
  hand.solverSpot=JSON.parse(readFileSync(new URL("fixtures/105496.json",import.meta.url)));
  reconstructSolverMath(hand.solverSpot);
  hand.solverResult={bestAction:"check"};
  context.document={querySelectorAll:()=>[],getElementById:()=>null};
  const running=vm.runInContext("runSolverForHand(hand.id)",context);
  assert.equal(hand.solverResult,null);assert.equal(hand.solverStatus,"starting");
  await vm.runInContext("runSolverForHand(hand.id)",context);assert.equal(calls,1);
  finish(Response.json({solution:{bestAction:"fold"}}));await running;
  assert.equal(hand.solverResult.bestAction,"fold");
});

test("a cancelled poll cannot restore a stale result after the hand is re-read",async()=>{
  let finish;
  const {context,hand}=appContext(()=>new Promise(resolve=>{finish=resolve}));
  hand.solverJob={solve:"old-job"};hand.solverStatus="pending";
  const polling=vm.runInContext("pollSolverJob(hand.id)",context);
  hand.solverJob=null;hand.solverStatus="";
  finish(Response.json({solution:{bestAction:"check"}}));await polling;
  assert.equal(hand.solverResult,undefined);assert.equal(hand.solverStatus,"");
});

test("zero tilt counts toward XP and tilt achievements",()=>{
  const {context}=appContext(async()=>{});
  vm.runInContext("state.sessions=Array.from({length:5},()=>({process:5,tilt:0,durationMs:0,pnl:0}))",context);
  const result=vm.runInContext("gamificationStats()",context);
  assert.equal(result.xp,625);assert.equal(result.achievements.find(a=>a.name==='Tilt Proof').on,true);
});

test("editing hand data invalidates the old solver spot and result",()=>{
  const {context,hand}=appContext(async()=>{});
  Object.assign(hand,{solverSpot:{heroCards:['Ah','Qh']},solverSpotVersion:7,solverResult:{bestAction:'fold'},solverJob:{solve:'old'}});
  vm.runInContext("invalidateHandSolver(hand)",context);
  assert.equal(hand.solverSpot,null);assert.equal(hand.solverSpotVersion,0);
  assert.equal(hand.solverResult,null);assert.equal(hand.solverJob,null);
});

test("mistyped action streets and amounts are reported instead of silently dropping rows",()=>{
  const {context}=appContext(async()=>{});
  context.text='flpp | BTN | bet | 5 | 50\nflop | BB | bet | oops | 50';
  const rows=vm.runInContext("parseSolverActionLines(text)",context);
  assert.equal(rows.length,2);
  context.spot={actionHistory:rows};
  const issues=vm.runInContext("solverLocalHistoryIssues(spot)",context);
  assert.ok(issues.some(issue=>issue.includes('invalid street')));
  assert.ok(issues.some(issue=>issue.includes('invalid amount')));
});

test("small nonzero solver frequencies remain visible and exact zero stays zero",()=>{
  const {context}=appContext(async()=>{});
  for(const [frequency,label] of [[.0013,'0.13%'],[.000001,'<0.01%'],[.8072,'80.7%'],[0,'0%'],[1,'100%']]){
    context.frequency=frequency;
    assert.equal(vm.runInContext("solverFrequencyLabel(frequency)",context),label);
  }
  context.strategy=[{action:'raise',amount_bb:37,frequency:.0013}];
  assert.match(vm.runInContext("solverStrategyBars(strategy)",context),/0\.13%/);
});

test("a cached explanation cannot misrepresent the strategy when its EV ranking differs",()=>{
  const {context}=appContext(async()=>{});
  context.solution={
    evReferenceVersion:1,
    strategy:[{action:'call',frequency:.8072},{action:'raise',amount_bb:37,frequency:.0013},{action:'fold',frequency:.19}],
    evs:{actions:['CALL','RAISE 37.000000','FOLD'],values:[5.097,13.688,0]},
    explanation:{summary:'Folding is least favored; raising is preferred.'}
  };
  const explanation=vm.runInContext("solverResultExplanation(solution,'RAISE 37.000000')",context);
  assert.match(explanation.summary,/CALL most often \(80\.7%\)/);
  assert.match(explanation.summary,/RAISE 37\.0 BB has the highest reported EV/);
  assert.match(explanation.details,/differ at this node/);
  assert.doesNotMatch(explanation.summary,/least favored|raising is preferred/);
});

test("the most frequent action retains its bet size when EVs are unavailable",()=>{
  const {context}=appContext(async()=>{});
  context.strategy=[{action:'bet',amount_bb:15,frequency:.7},{action:'bet',amount_bb:5,frequency:.3}];
  assert.equal(vm.runInContext("solverMostFrequentAction(strategy)",context),'bet 15');
  assert.equal(vm.runInContext("solverStrategyItem(strategy,solverMostFrequentAction(strategy)).frequency",context),.7);
});

