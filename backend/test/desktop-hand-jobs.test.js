import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const {createHandJobRunner}=createRequire(import.meta.url)('../../desktop/hand-jobs.cjs');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const request={requestId:'request-1',kind:'solve',handId:'hand-1',apiBase:'https://test.local',payload:{spot:{heroCards:['Qs','Qh']}}};
function setup(t,fetch){
  const directory=mkdtempSync(path.join(tmpdir(),'innergame-hand-jobs-')),calls=[],timers=[];
  const options={directory,fetch,onComplete:(job,notify)=>calls.push({job,notify}),delay:async()=>{},setTimer:fn=>{timers.push(fn);return 0;}};
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  return {directory,calls,timers,options,runner:createHandJobRunner(options),file:path.join(directory,'request-1.json')};
}

test('desktop job submission is deduplicated and a result remains on disk until the UI acknowledges it',async t=>{
  const requests=[];const app=setup(t,async(url,options)=>{
    requests.push({url,body:JSON.parse(options.body)});
    return url.endsWith('/start')?Response.json({jobId:'server-1'},{status:202}):Response.json({status:'complete',result:{solution:{bestAction:'call'}}});
  });
  app.runner.enqueue(request);app.runner.enqueue(request);await tick();
  assert.equal(requests.filter(x=>x.url.endsWith('/start')).length,1);assert.equal(app.calls.length,1);assert.equal(app.calls[0].notify,true);
  assert.equal(JSON.parse(readFileSync(app.file)).result.solution.bestAction,'call');
  await app.runner.deliver();assert.equal(app.calls.at(-1).notify,false);
  app.runner.ack({requestId:request.requestId});assert.equal(existsSync(app.file),false);
});

test('a desktop restart resumes the saved server job instead of submitting another solve',async t=>{
  let release;
  const app=setup(t,async url=>url.endsWith('/start')?Response.json({jobId:'server-1'},{status:202}):new Promise(resolve=>release=resolve));
  app.runner.enqueue(request);await tick();assert.equal(JSON.parse(readFileSync(app.file)).serverJobId,'server-1');
  const routes=[];
  const restarted=createHandJobRunner({...app.options,fetch:async url=>{routes.push(url);return Response.json({status:'complete',result:{solution:{bestAction:'check'}}});}});
  restarted.restore();await tick();
  assert.equal(routes.length,1);assert.ok(routes[0].endsWith('/poll'));assert.equal(app.calls.at(-1).job.result.solution.bestAction,'check');
  app.runner.ack({requestId:request.requestId});release(Response.json({status:'complete',result:{solution:{bestAction:'old'}}}));await tick();
  assert.equal(app.calls.length,1);
});

test('a dropped submission retries the same request ID and preserves pending work',async t=>{
  const submitted=[];let first=true;
  const app=setup(t,async(url,options)=>{
    if(url.endsWith('/start')){submitted.push(JSON.parse(options.body).requestId);if(first){first=false;throw new Error('Connection lost');}return Response.json({jobId:'server-1'},{status:202});}
    return Response.json({status:'complete',result:{solution:{}}});
  });
  app.runner.enqueue(request);await tick();assert.equal(JSON.parse(readFileSync(app.file)).status,'pending');
  assert.equal(app.timers.length,1);app.timers[0]();await tick();
  assert.deepEqual(submitted,['request-1','request-1']);assert.equal(app.calls[0].job.status,'complete');
});

test('cancelling a hand during its request prevents a late response from recreating its file or notification',async t=>{
  let finish;
  const app=setup(t,async url=>url.endsWith('/start')?Response.json({jobId:'server-1'},{status:202}):new Promise(resolve=>finish=resolve));
  app.runner.enqueue(request);await tick();app.runner.cancel({requestIds:['request-1']});
  finish(Response.json({status:'complete',result:{solution:{}}}));await tick();
  assert.equal(existsSync(app.file),false);assert.equal(app.calls.length,0);
});

test('an old offline desktop job expires with a saved retryable result',async t=>{
  const app=setup(t,async()=>assert.fail('An expired request must not be resubmitted'));
  writeFileSync(app.file,JSON.stringify({...request,status:'pending',createdAt:Date.now()-25*60*60_000}));
  app.runner.restore();await tick();
  assert.equal(app.calls.length,1);assert.equal(app.calls[0].job.status,'failed');
  assert.match(app.calls[0].job.error.message,/hand is saved/);assert.equal(app.timers.length,0);
});
