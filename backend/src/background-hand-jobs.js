import { randomUUID, createHash } from "node:crypto";

// The server owns slow provider calls. Native clients only submit once and
// collect the retained result, even if their UI or network connection closes.
export function createBackgroundHandJobs({ analyze, reconstruct, solve, poll, now=Date.now,
  delay=ms=>new Promise(resolve=>setTimeout(resolve,ms)), ttlMs=24*60*60_000,
  solveTimeoutMs=15*60_000, maxJobs=50 }={}) {
  const jobs=new Map(),requests=new Map();
  function canonical(value){return Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;}
  function remove(id){const job=jobs.get(id);if(job)requests.delete(job.requestId);jobs.delete(id);}
  function prune(){for(const [id,job] of jobs)if(job.status!=="pending"&&now()-job.completedAt>=ttlMs)remove(id);}
  function unwrap(response){
    if(response.status>=400)throw Object.assign(new Error(response.body?.message||response.body?.error||"Hand processing failed."),{status:response.status,payload:response.body});
    return response.body;
  }
  async function run(job,kind,payload){
    try{
      let result;
      if(kind==="analysis")result=unwrap(await analyze(payload));
      else if(kind==="reconstruction")result=await reconstruct(payload);
      else{
        const started=await solve(payload);
        result=unwrap(started);
        if(started.status===202){
          if(!result?.job?.solve)throw new Error("The solver did not return a job.");
          const providerJob=result.job,deadline=now()+solveTimeoutMs;
          do{
            await delay(2200);
            const response=await poll({job:providerJob});
            if(response.status===202||response.status>=500)continue;
            result=unwrap(response);
            if(!result?.solution)throw new Error("The solver did not return a solution.");
            break;
          }while(now()<deadline);
          if(!result?.solution)throw new Error("The solve took longer than expected. Your hand is saved; try again.");
        }
        if(!result?.solution)throw new Error("The solver did not return a solution.");
      }
      job.result=result;job.status="complete";
    }catch(error){
      job.status="failed";
      job.error={status:Number(error.status)||500,message:String(error.message||error),...(error.payload?{payload:error.payload}:{})};
    }finally{job.completedAt=now();}
  }
  return {
    start({requestId,kind,payload}){
      if(typeof requestId!=="string"||!requestId||requestId.length>128)throw Object.assign(new Error("A unique request ID is required."),{status:400});
      if(!["analysis","reconstruction","solve"].includes(kind))throw Object.assign(new Error("Unknown hand job type."),{status:400});
      if(!payload||typeof payload!=="object"||Array.isArray(payload))throw Object.assign(new Error("Hand job data is required."),{status:400});
      prune();
      const fingerprint=createHash("sha256").update(JSON.stringify(canonical({kind,payload}))).digest("hex");
      const existing=jobs.get(requests.get(requestId));
      if(existing){
        if(existing.fingerprint!==fingerprint)throw Object.assign(new Error("This request ID belongs to a different hand job."),{status:409});
        return existing.id;
      }
      if(jobs.size>=maxJobs){
        const finished=[...jobs.values()].filter(job=>job.status!=="pending").sort((a,b)=>a.completedAt-b.completedAt)[0];
        if(finished)remove(finished.id);
        else throw Object.assign(new Error("Hand processing is busy. Please try again shortly."),{status:503});
      }
      const id=randomUUID(),job={id,requestId,fingerprint,kind,status:"pending",createdAt:now()};
      jobs.set(id,job);requests.set(requestId,id);
      Promise.resolve().then(()=>run(job,kind,payload));
      return id;
    },
    get(id){prune();const job=jobs.get(id);if(!job)return null;const {fingerprint,...result}=job;return result;}
  };
}
