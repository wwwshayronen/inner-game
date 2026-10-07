import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY = "test-key";
process.env.POKERAI_API_KEY = "test-key";
const { app, client, solverReadiness, solverActionHistoryIssues, solverInspectJsonSchema, expectedPostflopSegments, legalSolverActions, actionFreq } = await import("../src/server.js");
const screenshot = () => JSON.parse(readFileSync(new URL("fixtures/105496.json", import.meta.url)));

// Exercise the real Express handlers without opening a port or calling providers.
async function request(path, body) {
  const handler = app.router.stack.find(layer => layer.route?.path === path).route.stack[0].handle;
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
  await handler({ body }, res);
  return res;
}

test("screenshot job completes and the resulting hand schedules the correct solver input", async t => {
  let finish;
  let modelCalls = 0;
  t.mock.method(client.responses, "create", () => {
    modelCalls++;
    return new Promise(resolve => { finish = resolve; });
  });
  const started = await request("/solver/inspect", { imageDataUrl: "data:image/jpeg;base64,test", async: true });
  assert.equal(started.statusCode, 202);
  assert.ok(started.body.inspectionId);
  const pending = await request("/solver/inspect/poll", { inspectionId: started.body.inspectionId });
  assert.equal(pending.statusCode, 202);
  finish({ output_text: JSON.stringify(screenshot()) });
  await new Promise(resolve => setImmediate(resolve));
  const completed = await request("/solver/inspect/poll", { inspectionId: started.body.inspectionId });
  assert.equal(completed.statusCode, 200);
  assert.equal(completed.body.ready, true);
  assert.deepEqual(solverReadiness(completed.body.spot), []);
  assert.equal(modelCalls, 1);

  const providerRequests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const body = JSON.parse(options.body);
    providerRequests.push({ url, body });
    if (url.endsWith("/v1/gto/preflop/range")) {
      return Response.json({ range: { AQs: { call: 0.5, raise: 0.5 }, AKs: { call: 0.25, raise: 0.75 } } });
    }
    if (url.endsWith("/v1/gto/solver")) return Response.json({ solve: "fixture-solve" });
    throw new Error("Unexpected provider request: " + url);
  });
  const scheduled = await request("/solver/solve", { spot: completed.body.spot });
  assert.equal(scheduled.statusCode, 202);
  assert.equal(scheduled.body.job.heroHand, "AhQh");
  assert.equal(scheduled.body.job.solve, "fixture-solve");
  const solver = providerRequests.find(row => row.url.endsWith("/v1/gto/solver")).body;
  assert.equal(solver.board, "AdTs8c");
  assert.equal(solver.hero, "IP");
  assert.equal(solver.pot, 34.5);
  assert.equal(solver.effective_stack, 156.39);
  assert.ok(solver.bet_sizes.turn.includes(80));
  assert.ok(solver.bet_sizes.river.includes(80));
  assert.equal(solver.bet_sizes.turn[0],80);
  assert.equal(solver.donk_sizes.river[0],80);
  assert.deepEqual(scheduled.body.job.expectedSegments, [
    { type: "CHECK" }, { type: "CHECK" }, { type: "CARD", card: "5h" },
    { type: "BET", amount: 27.6 }, { type: "CALL" }, { type: "CARD", card: "Jd" },
    { type: "BET", amount: 71.76 }
  ]);
  const ranges = providerRequests.filter(row => row.url.endsWith("/v1/gto/preflop/range"));
  assert.equal(ranges.length, 2);
  assert.ok(ranges.some(row => row.body.preflop_actions.some(action => action.action === "raise" && action.amount === 14.5)));
});

test("legacy screenshot requests still receive the synchronous result", async t => {
  t.mock.method(client.responses, "create", async () => ({ output_text: JSON.stringify(screenshot()) }));
  const res = await request("/solver/inspect", { imageDataUrl: "data:image/jpeg;base64,test" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ready, true);
});

test("extraction errors can be polled and malformed solver data gets validation feedback", async t => {
  t.mock.method(client.responses, "create", async () => ({ output_text: "invalid json" }));
  const started = await request("/solver/inspect", { imageDataUrl: "data:image/jpeg;base64,test", async: true });
  await new Promise(resolve => setImmediate(resolve));
  const failed = await request("/solver/inspect/poll", { inspectionId: started.body.inspectionId });
  assert.equal(failed.statusCode, 502);
  assert.equal(failed.body.error, "solver_extract_invalid_json");
  const missing = await request("/solver/inspect/poll", { inspectionId: "unknown" });
  assert.equal(missing.statusCode, 410);
  const invalid = await request("/solver/solve", { spot: {} });
  assert.equal(invalid.statusCode, 422);
  assert.equal(invalid.body.error, "invalid_spot");
  assert.ok(invalid.body.validation.length > 0);
});

test("a first-action shove is a valid opening bet in hand-history validation", () => {
  const spot = screenshot();
  spot.decisionStreet = "flop";
  spot.actionHistory = spot.actionHistory.filter(a => a.street === "preflop");
  spot.actionHistory.push({ street: "flop", position: "UTG", action: "allin", amountBb: 100, sizePctPot: 0 });
  assert.deepEqual(solverActionHistoryIssues(spot), []);
  spot.actionHistory.at(-1).action = "raise";
  assert.ok(solverActionHistoryIssues(spot).some(x => x.includes("raise appears without a prior bet")));
});

test("structured extraction requires continuation actions with the same schema as history", () => {
  assert.ok(solverInspectJsonSchema.required.includes("actionHistoryAfterDecision"));
  assert.deepEqual(solverInspectJsonSchema.properties.actionHistoryAfterDecision, solverInspectJsonSchema.properties.actionHistory);
});

test("complete replay boards do not move flop or turn decisions to a future street", () => {
  const spot=screenshot();spot.decisionStreet="flop";
  spot.actionHistory=spot.actionHistory.filter(a=>a.street==="preflop");
  spot.actionHistory.push({street:"flop",position:"UTG",action:"check",amountBb:0});
  assert.deepEqual(expectedPostflopSegments(spot),[{type:"CHECK"}]);
  spot.decisionStreet="turn";spot.actionHistory.push({street:"flop",position:"CO",action:"check",amountBb:0});
  assert.deepEqual(expectedPostflopSegments(spot),[{type:"CHECK"},{type:"CHECK"},{type:"CARD",card:"5h"}]);
});

test("QQ facing the river bet cannot check; invalid actors, completed paths and duplicate cards are rejected", () => {
  const spot=JSON.parse(readFileSync(new URL("fixtures/105296.json",import.meta.url)));
  assert.deepEqual(solverReadiness(spot),[]);
  assert.deepEqual(legalSolverActions(spot),["fold","call","raise","allin"]);
  spot.actionHistory.push({street:"river",position:"BTN",action:"call",amountBb:14.7});
  assert.ok(solverActionHistoryIssues(spot).some(issue=>issue.includes("already ends")));
  spot.heroCards=["Qc","Qh"];
  assert.ok(solverReadiness(spot).some(issue=>issue.includes("Duplicate cards")));
});

test("polling calibrates EVs and caches a completed result before releasing the provider solve", async t => {
  const spot=screenshot(),path="root/CHECK/CHECK/5h/BET 28.000000/CALL/Jd/BET 72.000000";
  let calls=0;
  t.mock.method(client.responses,"create",async()=>({output_text:JSON.stringify({summary:"Study",details:"",facts:[]})}));
  t.mock.method(globalThis,"fetch",async(url)=>{
    calls++;
    if(url.endsWith("/tree"))return Response.json({spot_status:"queryable",nodes:[{node:path,is_hero:true,token:"node-token"}]});
    if(url.endsWith("/node"))return Response.json({strategy:[{action:"call",frequency:.7},{action:"fold",frequency:.3}]});
    if(url.endsWith("/evs"))return Response.json({actions:["CALL","FOLD"],evs:[-59.00813293457031,-45.249996185302734]});
    if(url.endsWith("/release"))return Response.json({});
    throw new Error(url);
  });
  const job={solve:"ev-regression",heroHand:"AhQh",decisionStreet:"river",turnCard:"5h",riverCard:"Jd",spot,expectedSegments:expectedPostflopSegments(spot)};
  const result=await request("/solver/poll",{job});
  assert.equal(result.statusCode,200);assert.equal(result.body.solution.bestEv,0);
  assert.equal(result.body.solution.bestAction,"fold");assert.equal(result.body.solution.evs.reference,"decision");
  const count=calls;assert.deepEqual((await request("/solver/poll",{job})).body,result.body);assert.equal(calls,count);
  assert.equal(actionFreq([{action:"bet",amount_bb:5,frequency:.1},{action:"bet",amount_bb:15,frequency:.9}],"bet 15.000000"),.9);
});

test("check EV is calibrated using a zero-cost adjacent path, with a labeled fallback when calibration fails", async t => {
  const spot=screenshot();spot.decisionStreet="flop";
  spot.actionHistory=spot.actionHistory.filter(a=>a.street==="preflop");spot.actionHistory.push({street:"flop",position:"UTG",action:"check",amountBb:0});
  let failProbe=false;
  t.mock.method(client.responses,"create",async()=>({output_text:JSON.stringify({summary:"Study",details:"",facts:[]})}));
  t.mock.method(globalThis,"fetch",async(url,options)=>{
    if(url.endsWith("/tree"))return Response.json({spot_status:"queryable",nodes:[{node:"root/CHECK",is_hero:true,token:"node"},{node:"root/BET 5.000000",is_hero:true,token:"probe"}]});
    if(url.endsWith("/node"))return Response.json({strategy:[{action:"check",frequency:.95},{action:"bet",amount_bb:5,frequency:.05}]});
    if(url.endsWith("/evs")){
      if(JSON.parse(options.body).node_id==="root/CHECK")return Response.json({actions:["CHECK","BET 5.000000"],evs:[-6.475,-8.668]});
      if(failProbe)return Response.json({error:"unavailable"},{status:500});
      return Response.json({actions:["FOLD","CALL"],evs:[-7.475,-9]});
    }
    return Response.json({});
  });
  const job={solve:"check-calibration",heroHand:"AhQh",decisionStreet:"flop",spot,expectedSegments:[{type:"CHECK"}]};
  const result=await request("/solver/poll",{job});assert.equal(result.body.solution.bestEv,1);
  failProbe=true;job.solve="check-uncalibrated";
  const fallback=await request("/solver/poll",{job});assert.equal(fallback.body.solution.evs.reference,"provider");
  assert.equal(fallback.body.solution.evs.values[0],-6.475);
});

test("a queryable but incomplete tree gets bounded retries and never substitutes a check for a bet", async t => {
  let now=1000000,released=false;
  t.mock.method(Date,"now",()=>now);
  t.mock.method(globalThis,"fetch",async(url)=>{
    if(url.endsWith("/release")){released=true;return Response.json({});}
    return Response.json({spot_status:"queryable",nodes:[{node:"root/CHECK",is_hero:true,token:"wrong"}]});
  });
  const job={solve:"missing-path",heroHand:"AhQh",decisionStreet:"flop",spot:screenshot(),expectedSegments:[{type:"BET",amount:10}]};
  assert.equal((await request("/solver/poll",{job})).statusCode,202);
  now+=31000;
  const failed=await request("/solver/poll",{job});assert.equal(failed.statusCode,422);
  assert.equal(failed.body.error,"action_path_not_in_tree");assert.equal(released,true);
});

test("a provider check response is rejected when the hand faces a bet",async t=>{
  const spot=screenshot(),node="root/CHECK/CHECK/5h/BET 28.000000/CALL/Jd/BET 72.000000";
  t.mock.method(globalThis,"fetch",async url=>{
    if(url.endsWith("/tree"))return Response.json({spot_status:"queryable",nodes:[{node,is_hero:true,token:"wrong-actions"}]});
    if(url.endsWith("/node"))return Response.json({strategy:[{action:"check",frequency:1}]});
    return Response.json({});
  });
  const result=await request("/solver/poll",{job:{solve:"illegal-actions",heroHand:"AhQh",decisionStreet:"river",spot,expectedSegments:expectedPostflopSegments(spot)}});
  assert.equal(result.statusCode,422);assert.equal(result.body.error,"invalid_solver_decision");
});
