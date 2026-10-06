import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

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
  assert.equal(hand.solverSpotVersion, 6);
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
  assert.equal(hand.solverSpotVersion, 6);
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
