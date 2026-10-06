import { randomUUID } from "node:crypto";

// Keep slow image reads outside the mobile request window. Completed jobs stay
// available briefly so a dropped poll can be retried without another model call.
export function createInspectionJobs({ ttlMs = 15 * 60_000, maxJobs = 50, now = Date.now } = {}) {
  const jobs = new Map();
  function prune() {
    for (const [id, job] of jobs) {
      if (now() - job.createdAt >= ttlMs) jobs.delete(id);
    }
  }
  return {
    start(run) {
      prune();
      if (jobs.size >= maxJobs) {
        throw Object.assign(new Error("Screenshot reader is busy. Try again shortly."), { status: 503, code: "inspection_busy" });
      }
      const id = randomUUID();
      const job = { createdAt: now(), status: "pending" };
      jobs.set(id, job);
      Promise.resolve().then(run).then(
        result => { job.status = "complete"; job.result = result; },
        error => { job.status = "failed"; job.error = error; }
      );
      return id;
    },
    get(id) {
      prune();
      return jobs.get(id);
    }
  };
}
