import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {reconstructSolverMath} from '../src/solver-math.js';
const source=readFileSync(new URL('../../android/app/src/main/assets/www/app.js',import.meta.url),'utf8');
const fixture=()=>JSON.parse(readFileSync(new URL('fixtures/105496.json',import.meta.url)));
function client(saved){
  const calls={jobs:[],ack:[],cancel:[],images:[]};let next=0,storage=saved||null;
  const bridge={enqueueHandJob:json=>{calls.jobs.push(JSON.parse(json));return '{"accepted":true}';},
    ackHandJob:json=>calls.ack.push(JSON.parse(json)),cancelHandJobs:json=>calls.cancel.push(JSON.parse(json)),ackNativeAnalysis:()=>{}};
  const context=vm.createContext({window:{InnerGameNative:bridge},structuredClone,AbortSignal,console,
    localStorage:{getItem:key=>key==='innerGame.v5'?storage:null,setItem:(_key,value)=>storage=value},
    crypto:{randomUUID:()=>`job-${++next}`},fetch:()=>assert.fail('Native jobs must not depend on WebView polling.'),
    storeImage:(key,data)=>calls.images.push({key,data}),setTimeout:()=>0,
    document:{querySelectorAll:()=>[],getElementById:()=>null}});
  vm.runInContext(source.slice(0,source.lastIndexOf('\nsave();\n')),context);
  vm.runInContext("render=()=>{};captureToast=()=>{};refreshCaptureUi=()=>{};getHandImage=async()=> 'data:image/jpeg;base64,test';storeHandImage=async(key,data)=>storeImage(key,data);",context);
  const run=code=>vm.runInContext(code,context);
  return {calls,run,context,saved:()=>storage};
}
function addHand(app,spot){
  app.context.spot=spot;
  app.run("state.generalHands.push({id:'hand',imageKey:'image',title:'QQ',solverSpot:spot});selectedHandId='hand';solverReviewHandId='hand';");
}
async function deliver(app,job){app.context.job=job;return app.run('window.innerGameReceiveHandJob(job)');}

test('reconstruction is queued natively, persists while pending and collects into a relaunched app',async()=>{
  const app=client();addHand(app);await app.run("inspectHandForSolver('hand',true)");
  assert.equal(app.calls.jobs.length,1);const job=app.calls.jobs[0];assert.equal(job.kind,'reconstruction');
  assert.equal(app.run('findHandRecord("hand").reconstructionStatus'),'pending');
  assert.match(app.run('solverReview()'),/You can leave the app/);
  const restored=client(app.saved());assert.equal(restored.run('findHandRecord("hand").backgroundReconstructionId'),job.requestId);
  await deliver(restored,{...job,status:'complete',result:{spot:fixture(),ready:true}});
  assert.equal(restored.run('findHandRecord("hand").solverSpotVersion'),7);
  assert.equal(restored.run('findHandRecord("hand").reconstructionStatus'),'ready');
  assert.equal(restored.calls.ack.length,1);assert.equal(restored.calls.jobs.length,0);
});

test('native solves are queued only once and preserve the full calibrated solver response',async()=>{
  const app=client(),spot=fixture();reconstructSolverMath(spot);addHand(app,spot);
  await app.run("runSolverForHand('hand')");await app.run("runSolverForHand('hand')");assert.equal(app.calls.jobs.length,1);
  const job=app.calls.jobs[0];assert.equal(job.kind,'solve');assert.equal(app.run('findHandRecord("hand").solverStatus'),'pending');
  const solution={street:'river',bestAction:'fold',evReferenceVersion:1,evs:{actions:['FOLD','CALL'],values:[0,-1],reference:'decision'}};
  await deliver(app,{...job,status:'complete',result:{solution}});
  assert.equal(app.run('findHandRecord("hand").solverStatus'),'solved');
  assert.deepEqual(JSON.parse(app.run('JSON.stringify(findHandRecord("hand").solverResult)')),solution);
});

test('an incomplete hand is not submitted for a paid solve',async()=>{
  const app=client();addHand(app,{});await app.run("runSolverForHand('hand')");assert.equal(app.calls.jobs.length,0);
  assert.match(app.run('findHandRecord("hand").solverError'),/Complete/);
});

test('an incomplete completion response shows a retryable failure instead of a solved hand',async()=>{
  const app=client(),spot=fixture();reconstructSolverMath(spot);addHand(app,spot);
  await app.run("runSolverForHand('hand')");const job=app.calls.jobs[0];
  await deliver(app,{...job,status:'complete',result:{}});
  assert.equal(app.run('findHandRecord("hand").solverStatus'),'failed');
  assert.match(app.run('findHandRecord("hand").solverError'),/result was incomplete/);
  assert.equal(app.run('findHandRecord("hand").imageKey'),'image');
});

test('edits and a re-read dismiss stale reconstruction results instead of overwriting the hand',async()=>{
  const app=client();addHand(app);await app.run("inspectHandForSolver('hand',true)");const first=app.calls.jobs[0];
  await app.run("inspectHandForSolver('hand',true)");const second=app.calls.jobs[1];
  await deliver(app,{...first,status:'complete',result:{spot:{heroCards:['As','Ks']}}});
  assert.equal(app.run('findHandRecord("hand").solverSpot'),undefined);
  assert.equal(app.run('findHandRecord("hand").backgroundReconstructionId'),second.requestId);
  app.run('invalidateHandSolver(findHandRecord("hand"))');
  await deliver(app,{...second,status:'complete',result:{spot:fixture()}});
  assert.equal(app.run('findHandRecord("hand").solverSpot'),null);assert.equal(app.calls.cancel.length,2);
});

test('editing a solver spot cancels its pending solve before a late result arrives',async()=>{
  const app=client(),spot=fixture();reconstructSolverMath(spot);addHand(app,spot);await app.run("runSolverForHand('hand')");const job=app.calls.jobs[0];
  app.run("document.querySelectorAll=()=>[{dataset:{solverField:'heroCards'},value:'As Kh'}];collectSolverSpot()");
  await deliver(app,{...job,status:'complete',result:{solution:{bestAction:'call'}}});
  assert.equal(app.run('findHandRecord("hand").solverResult'),null);
  assert.equal(app.run('findHandRecord("hand").solverStatus'),'');
  assert.equal(app.run('findHandRecord("hand").solverSpot.heroCards.join(" ")'),'As Kh');
});

test('a failed solver job shows its error and missing details while keeping the screenshot',async()=>{
  const app=client(),spot=fixture();reconstructSolverMath(spot);addHand(app,spot);await app.run("runSolverForHand('hand')");const job=app.calls.jobs[0];
  await deliver(app,{...job,status:'failed',error:{message:'Review hero cards',payload:{missingFields:['Hero cards']}}});
  assert.equal(app.run('findHandRecord("hand").solverStatus'),'failed');assert.equal(app.run('findHandRecord("hand").solverError'),'Review hero cards');
  assert.equal(app.run('findHandRecord("hand").imageKey'),'image');assert.equal(app.run('findHandRecord("hand").solverSpot.missingFields[0]'),'Hero cards');
});

test('analysis completed in the background stays in its original session and ignores idle captures',async()=>{
  const app=client(),now=Date.now();app.context.now=now;
  app.run("state.sessions.push({id:'previous',captureStartedAt:now-1000,captureEndedAt:now-100,hands:[]});state.activeSession={id:'next',startedAt:now,hands:[]}");
  const job={requestId:'capture-1',handId:'capture-1',kind:'analysis',source:'android_auto',sessionId:'previous',capturedAt:now-500,
    payload:{imageDataUrl:'image'},status:'complete',result:{isPokerHand:true,title:'QQ river',heroCards:['Qs','Qh']}};
  await deliver(app,job);assert.equal(app.run('state.sessions[0].hands[0].status'),'ready');assert.equal(app.run('state.activeSession.hands.length'),0);
  await deliver(app,{...job,requestId:'idle',handId:'idle',capturedAt:now-50});
  assert.equal(app.run('allHandsLibrary().length'),1);assert.equal(app.calls.images.length,1);
});

test('deleting a pending auto-captured hand prevents it from reappearing on completion',async()=>{
  const app=client(),now=Date.now();app.context.now=now;app.run("state.activeSession={id:'active',startedAt:now-1000,hands:[]}");
  app.context.capture={id:'auto-hand',source:'android_auto',sessionId:'active',capturedAt:now-500,backgroundAnalysisId:'auto-job'};
  app.run('saveCapturedHand(capture);removeCapturedHand(capture.id)');
  await deliver(app,{requestId:'auto-job',handId:'auto-hand',kind:'analysis',source:'android_auto',sessionId:'active',capturedAt:now-500,
    payload:{imageDataUrl:'image'},status:'complete',result:{isPokerHand:true}});
  assert.equal(app.run('allHandsLibrary().length'),0);assert.equal(app.calls.images.length,0);
});

test('notification links open the matching hand and the requested reconstruction or solver screen',()=>{
  const app=client();addHand(app);app.run('navigate=view=>{route=view}');
  assert.equal(app.run('window.innerGameOpenHand("hand","solverResult")'),true);
  assert.equal(app.run('route'),'solverResult');assert.equal(app.run('solverReviewHandId'),'hand');
  app.run('window.innerGameOpenHand("hand","solverReview")');assert.equal(app.run('route'),'solverReview');
  app.run('window.innerGameOpenHand("hand","unknown")');assert.equal(app.run('route'),'handDetail');
});
