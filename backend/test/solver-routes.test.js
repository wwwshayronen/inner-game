import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY = "test-key";
process.env.POKERAI_API_KEY = "test-key";
const { app, client, solverReadiness, solverActionHistoryIssues, solverInspectJsonSchema } = await import("../src/server.js");
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
