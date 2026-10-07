import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { reconstructSolverMath } from "../src/solver-math.js";

const screenshot = () => JSON.parse(readFileSync(new URL("fixtures/105496.json", import.meta.url)));

test("105496: final call reconciles the pot without changing the decision path", () => {
  const spot = screenshot();
  const history = structuredClone(spot.actionHistory);
  const result = reconstructSolverMath(spot);
  assert.deepEqual(result.issues, []);
  assert.equal(result.finalPotFromActions, 347.28);
  assert.equal(result.heroStartBb, 172.89);
  assert.equal(result.villainStartBb, 245.27);
  assert.equal(spot.potAtDecisionBb, 161.46);
  assert.equal(spot.flopStartPotBb, 34.5);
  assert.equal(spot.flopStartEffectiveStackBb, 156.39);
  assert.equal(spot.heroStackBb, 128.79);
  assert.equal(spot.villainStackBb, 129.41);
  assert.deepEqual(spot.actionHistory.map(({ sizePctPot, ...row }) => row), history.map(({ sizePctPot, ...row }) => row));
  assert.equal(spot.actionHistory.at(-1).sizePctPot, 80);
  assert.ok(spot.extractionNotes.includes("Hero is cantgopro at the bottom-center seat."));
  assert.deepEqual(spot.missingFields, []);
});

test("completed betting still rejects a mistranscribed final pot", () => {
  const spot = screenshot();
  spot.finalPotBb = 400;
  const result = reconstructSolverMath(spot);
  assert.ok(result.issues.some(x => x.startsWith("Final pot does not reconcile")));
  assert.equal(spot.actionHistoryComplete, false);
});

test("an unfinished betting line is not compared against the final pot", () => {
  const spot = screenshot();
  spot.actionHistoryAfterDecision = [];
  const result = reconstructSolverMath(spot);
  assert.equal(result.issues.some(x => x.startsWith("Final pot does not reconcile")), false);
  assert.ok(spot.extractionNotes.some(x => x.includes("remaining betting actions")));
});

test("short all-in call returns the opponent's excess before checking the pot", () => {
  const spot = screenshot();
  spot.observedHeroAction = "call";
  spot.observedHeroAmountBb = 58.95;
  spot.actionHistoryAfterDecision = [];
  spot.actionHistory.at(-1).amountBb = 95.375;
  spot.finalPotBb = 207.6;
  const result = reconstructSolverMath(spot);
  assert.equal(result.uncalledReturnBb, 36.425);
  assert.equal(result.finalPotFromActions, 207.6);
  assert.deepEqual(result.issues, []);
});

test("fold returns uncalled wager before final-pot validation", () => {
  const spot = screenshot();
  spot.observedHeroAction = "fold";
  spot.observedHeroAmountBb = 0;
  spot.actionHistoryAfterDecision = [];
  spot.finalPotBb = 89.7;
  const result = reconstructSolverMath(spot);
  assert.equal(result.uncalledReturnBb, 71.76);
  assert.equal(result.finalPotFromActions, 89.7);
  assert.deepEqual(result.issues, []);
});

test("reconstructing a saved spot again preserves amounts and stacks", () => {
  const spot = screenshot();
  const first = reconstructSolverMath(spot);
  const again = reconstructSolverMath(spot);
  assert.equal(again.finalPotFromActions, first.finalPotFromActions);
  assert.equal(again.heroStartBb, first.heroStartBb);
  assert.equal(again.villainStartBb, first.villainStartBb);
  assert.deepEqual(again.issues, []);
});
test("raise sizing uses the raise increment and pot after calling",()=>{
  const spot={heroPosition:"CO",villainPosition:"UTG",decisionStreet:"flop",observedHeroAction:"unknown",streetStartPotsBb:{flop:10},actionHistory:[
    {street:"preflop",position:"SB",action:"small_blind",amountBb:.5},
    {street:"preflop",position:"BB",action:"big_blind",amountBb:1},
    {street:"preflop",position:"UTG",action:"raise",amountBb:4.25},
    {street:"preflop",position:"CO",action:"call",amountBb:4.25},
    {street:"flop",position:"UTG",action:"bet",amountBb:5},
    {street:"flop",position:"CO",action:"raise",amountBb:15}
  ]};
  reconstructSolverMath(spot);
  assert.equal(spot.actionHistory.at(-1).sizePctPot,50);
});
