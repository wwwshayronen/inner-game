import test from "node:test";
import assert from "node:assert/strict";
import { createInspectionJobs } from "../src/inspection-jobs.js";

test("inspection returns a pending handle while image extraction is unfinished", async () => {
  const jobs = createInspectionJobs();
  let finish;
  let calls = 0;
  const id = jobs.start(() => { calls++; return new Promise(resolve => { finish = resolve; }); });
  assert.equal(jobs.get(id).status, "pending");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(jobs.get(id).status, "pending");
  const result = { spot: { heroCards: ["Ah", "Qh"] }, ready: true };
  finish(result);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(jobs.get(id).status, "complete");
  assert.deepEqual(jobs.get(id).result, result);
  assert.deepEqual(jobs.get(id).result, result);
  assert.equal(calls, 1);
});

test("inspection failures are retained for polling without an unhandled rejection", async () => {
  const jobs = createInspectionJobs();
  const error = new Error("Image could not be read");
  const id = jobs.start(() => { throw error; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(jobs.get(id).status, "failed");
  assert.equal(jobs.get(id).error, error);
});

test("inspection storage expires jobs and bounds capacity", async () => {
  let clock = 0;
  const jobs = createInspectionJobs({ ttlMs: 100, maxJobs: 1, now: () => clock });
  const id = jobs.start(() => ({ ready: true }));
  assert.throws(() => jobs.start(() => ({})), { code: "inspection_busy", status: 503 });
  await new Promise(resolve => setImmediate(resolve));
  clock = 100;
  assert.equal(jobs.get(id), undefined);
  assert.ok(jobs.start(() => ({})));
  assert.equal(jobs.get("unknown"), undefined);
});
