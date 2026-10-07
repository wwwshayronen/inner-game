import test from 'node:test';
import assert from 'node:assert/strict';
import {createBackgroundHandJobs} from '../src/background-hand-jobs.js';
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('reconstruction completes independently of clients and duplicate submissions reuse the same job',async()=>{
  let finish,calls=0;
  const jobs=createBackgroundHandJobs({reconstruct:()=>{calls++;return new Promise(resolve=>finish=resolve);}});
  const request={requestId:'reconstruction-1',kind:'reconstruction',payload:{imageDataUrl:'image',hand:{title:'QQ'}}};
  const id=jobs.start(request);
  assert.equal(jobs.start({...request,payload:{hand:{title:'QQ'},imageDataUrl:'image'}}),id);
  assert.equal(jobs.get(id).status,'pending');await tick();assert.equal(calls,1);
  finish({spot:{heroCards:['Qs','Qh']},ready:true});await tick();
  assert.equal(jobs.get(id).status,'complete');
  assert.deepEqual(jobs.get(id).result.spot.heroCards,['Qs','Qh']);
  assert.equal(jobs.start(request),id);assert.equal(calls,1);
  assert.throws(()=>jobs.start({...request,payload:{imageDataUrl:'different'}}),error=>error.status===409);
});

test('the server drives the solver through pending and temporary provider errors to its final result',async()=>{
  let now=0,polls=0;
  const solution={bestAction:'call',evs:{actions:['FOLD','CALL'],values:[0,5],reference:'decision'}};
  const jobs=createBackgroundHandJobs({now:()=>now,delay:async ms=>{now+=ms;},
    solve:async()=>({status:202,body:{job:{solve:'provider-1'}}}),
    poll:async({job})=>{
      assert.equal(job.solve,'provider-1');polls++;
      return polls===1?{status:202,body:{status:'pending'}}:polls===2?{status:500,body:{error:'Temporary connection failure'}}:{status:200,body:{solution}};
    }});
  const id=jobs.start({requestId:'solver-1',kind:'solve',payload:{spot:{}}});await tick();
  assert.equal(polls,3);assert.equal(jobs.get(id).status,'complete');assert.deepEqual(jobs.get(id).result.solution,solution);
});

test('synchronous preflop solutions complete without querying a postflop tree',async()=>{
  const jobs=createBackgroundHandJobs({solve:async()=>({status:200,body:{solution:{street:'preflop'}}}),poll:()=>assert.fail('No postflop poll')});
  const id=jobs.start({requestId:'preflop',kind:'solve',payload:{spot:{}}});await tick();
  assert.equal(jobs.get(id).result.solution.street,'preflop');
});

test('validation failures and reconstruction errors remain available as terminal results',async()=>{
  const jobs=createBackgroundHandJobs({solve:async()=>({status:422,body:{error:'incomplete_hand',message:'Review the missing details',missingFields:['Hero cards']}}),
    reconstruct:async()=>{throw Object.assign(new Error('Could not read the screenshot'),{status:502});}});
  const id=jobs.start({requestId:'bad-solve',kind:'solve',payload:{spot:{}}});
  const readId=jobs.start({requestId:'bad-image',kind:'reconstruction',payload:{imageDataUrl:'image'}});await tick();
  assert.equal(jobs.get(id).status,'failed');assert.equal(jobs.get(id).error.status,422);
  assert.deepEqual(jobs.get(id).error.payload.missingFields,['Hero cards']);assert.equal(jobs.get(readId).error.status,502);
});

test('bounded solver waiting fails honestly rather than manufacturing a solution',async()=>{
  let now=0;
  const jobs=createBackgroundHandJobs({now:()=>now,delay:async ms=>now+=ms,solveTimeoutMs:4000,
    solve:async()=>({status:202,body:{job:{solve:'slow'}}}),poll:async()=>({status:202,body:{}})});
  const id=jobs.start({requestId:'slow',kind:'solve',payload:{spot:{}}});await tick();
  assert.equal(jobs.get(id).status,'failed');assert.match(jobs.get(id).error.message,/longer than expected/);assert.equal(jobs.get(id).result,undefined);
});

test('late collection survives client disconnection and bounded storage evicts completed jobs before active work',async()=>{
  let now=0,finish;
  const jobs=createBackgroundHandJobs({now:()=>now,ttlMs:86400000,maxJobs:2,analyze:async()=>({status:200,body:{isPokerHand:true}}),
    reconstruct:()=>new Promise(resolve=>finish=resolve)});
  const completed=jobs.start({requestId:'finished',kind:'analysis',payload:{}});await tick();
  now=6*60*60_000;assert.equal(jobs.get(completed).status,'complete');
  const pending=jobs.start({requestId:'working',kind:'reconstruction',payload:{}});await tick();
  jobs.start({requestId:'new-analysis',kind:'analysis',payload:{}});await tick();
  assert.equal(jobs.get(completed),null);assert.equal(jobs.get(pending).status,'pending');
  finish({spot:{},ready:true});await tick();now+=86400000;assert.equal(jobs.get(pending),null);
});
