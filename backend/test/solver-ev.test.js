import test from "node:test";
import assert from "node:assert/strict";
import { numericEv, readEvs, normalizeDecisionEvs, bestEvAction, foldReferenceNodes } from "../src/solver-ev.js";

test("negative provider fold EV establishes zero without changing action differences", () => {
  const evs=normalizeDecisionEvs({actions:["CALL","FOLD"],values:[-59.00813293457031,-45.249996185302734]});
  assert.equal(evs.reference,"decision");
  assert.equal(evs.values[1],0);
  assert.ok(Math.abs(evs.values[0]+13.758136749267578)<1e-9);
  assert.deepEqual(bestEvAction(evs.actions,evs.values),{action:"fold",ev:0});
  assert.equal(evs.rawValues[1],-45.249996185302734);
});

test("a check node is calibrated against an adjacent fold; profitable checks stay positive", () => {
  const evs=normalizeDecisionEvs({actions:["CHECK","BET 5.000000"],values:[-6.475,-8.668]},
    {actions:["FOLD","CALL"],values:[-7.475,-9]},"root/BET 5.000000");
  assert.equal(evs.values[0],1);
  assert.ok(Math.abs(evs.values[1]+1.193)<1e-9);
  assert.equal(evs.baselineNode,"root/BET 5.000000");
});

test("missing EVs are unavailable, never zero, and absent calibration preserves the provider reference", () => {
  for(const value of [null,undefined,"",false," ",[],{}])assert.equal(numericEv(value),null);
  assert.deepEqual(bestEvAction(["CALL","FOLD"],[-3,null]),{action:"call",ev:-3});
  const evs=normalizeDecisionEvs({actions:["CHECK","BET 5"],values:[-7.475,null]},null);
  assert.equal(evs.reference,"provider");
  assert.deepEqual(evs.values,[-7.475,null]);
});

test("EV arrays stay aligned and reverse hole-card ordering is accepted", () => {
  assert.deepEqual(readEvs({actions:["CALL","FOLD"],evs:{QhQs:[-9]}},"QsQh"),{actions:["CALL","FOLD"],values:[-9,null]});
  assert.equal(readEvs({spot_status:"computing"},"QsQh"),null);
});

test("fold calibration never queries a path where Hero invests additional chips", () => {
  const nodes=[
    {node:"root/BET 5.000000",is_hero:true},
    {node:"root/BET 15.000000",is_hero:true},
    {node:"root/CHECK/BET 5.000000/RAISE 15.000000",is_hero:true},
    {node:"root/BET 1.000000",is_hero:false},
    {node:"root/CHECK/BET 5.000000",is_hero:true}
  ];
  assert.deepEqual(foldReferenceNodes(nodes,{node:"root/CHECK"}).map(x=>x.node),["root/BET 5.000000","root/BET 15.000000"]);
  assert.deepEqual(foldReferenceNodes(nodes,{node:"root"}).map(x=>x.node),["root/CHECK/BET 5.000000"]);
});
