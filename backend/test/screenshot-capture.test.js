import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import path from "node:path";

const appSource=readFileSync(new URL("../../android/app/src/main/assets/www/app.js",import.meta.url),"utf8");
const desktopSource=readFileSync(new URL("../../desktop/main.cjs",import.meta.url),"utf8");
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const pokerResponse=()=>Response.json({isPokerHand:true,title:"QQ river",heroCards:["Qs","Qh"],board:["Qc","3s","4s","2s","Jd"]});

function webApp(fetch=pokerResponse){
  const calls={bridge:[],images:[],requests:[]};
  let nextId=0;
  class Clock extends Date {static now(){return 10000;}}
  const bridge=Object.fromEntries(['setAutoScreenshotEnabled','notifyHand','ackNativeAnalysis'].map(name=>[
    name,payload=>calls.bridge.push({name,...JSON.parse(payload)})
  ]));
  const context=vm.createContext({
    window:{InnerGameNative:bridge},localStorage:{getItem:()=>null,setItem:()=>{}},
    structuredClone,Date:Clock,crypto:{randomUUID:()=>`shot-${++nextId}`},console,
    fetch:(url,options)=>{calls.requests.push({url,body:JSON.parse(options.body)});return fetch(url,options);},
    storeImage:(key,data)=>calls.images.push({key,data}),
    setTimeout:callback=>{queueMicrotask(callback);return 0;}
  });
  vm.runInContext(appSource.slice(0,appSource.lastIndexOf("\nsave();\n")),context);
  vm.runInContext(`
    resizeScreenshot=async data=>data;
    storeHandImage=async(key,data)=>storeImage(key,data);
    render=()=>{}; refreshCaptureUi=()=>{}; captureToast=()=>{};
  `,context);
  return {context,calls,run:code=>vm.runInContext(code,context)};
}

test("the screenshot watcher is disabled at launch and tracks session start, finish and restore",()=>{
  const {calls,run}=webApp();
  run("save(); save()");
  assert.deepEqual(calls.bridge,[{name:'setAutoScreenshotEnabled',enabled:false,sessionId:'',startedAt:0}]);
  run("state.activeSession={id:'first',startedAt:8000,hands:[]}; save(); save()");
  run("state.activeSession=null; save()");
  run("state.activeSession={id:'restored',startedAt:9000,hands:[]}; save()");
  assert.deepEqual(calls.bridge.map(({enabled,sessionId})=>({enabled,sessionId})),[
    {enabled:false,sessionId:''},{enabled:true,sessionId:'first'},
    {enabled:false,sessionId:''},{enabled:true,sessionId:'restored'}
  ]);
});

test("automatic screenshots outside a session do no image storage, notification or network work",async()=>{
  const {calls,run}=webApp();
  for(const source of ['android_auto','desktop_auto','desktop_hotkey','native']){
    assert.equal(await run(`window.innerGameReceiveScreenshot('data:image/png;base64,test','${source}')`),false);
  }
  assert.equal(calls.images.length,0);assert.equal(calls.requests.length,0);assert.equal(calls.bridge.length,0);
  assert.equal(run('allHandsLibrary().length'),0);
});

test("automatic captures require the current session, while explicit imports still work outside sessions",async()=>{
  const {calls,run}=webApp();
  run("state.activeSession={id:'current',startedAt:8000,hands:[]}");
  assert.equal(await run("window.innerGameReceiveScreenshot('data:image/png;base64,test','desktop_auto','previous')"),false);
  assert.equal(calls.requests.length,0);
  assert.equal(await run("window.innerGameReceiveScreenshot('data:image/png;base64,test','desktop_auto','current')"),true);
  assert.equal(run("state.activeSession.hands[0].sessionId"),'current');
  assert.equal(run("state.activeSession.hands[0].status"),'ready');
  run("state.activeSession=null; save()");
  assert.equal(await run("window.innerGameReceiveScreenshot('data:image/png;base64,test','desktop_auto','current')"),false);
  for(const source of ['android_share','desktop_drop']){
    assert.equal(await run(`window.innerGameReceiveScreenshot('data:image/png;base64,test','${source}')`),true);
  }
  assert.equal(run('generalHands().length'),2);
  assert.equal(calls.requests.length,3);
});

test('capture acknowledgement appears before slow resize, storage or analysis',async()=>{
  const {context,calls,run}=webApp();let release;
  context.messages=[];context.slowImage=()=>new Promise(resolve=>{release=resolve;});
  run("captureToast=message=>messages.push(message);resizeScreenshot=slowImage");
  const processing=run("window.innerGameReceiveScreenshot('data:image/png;base64,test','manual_upload')");
  assert.equal(context.messages[0],'Screenshot captured · processing…');
  assert.equal(calls.images.length,0);assert.equal(calls.requests.length,0);
  release('data:image/png;base64,test');await processing;
  assert.equal(calls.requests.length,1);
});

test('library rows open their hand directly and omit empty note prompts',()=>{
  const {context,run}=webApp();
  context.hand={id:'saved',title:'River decision',status:'ready',_scope:'session',_sessionId:'session',notes:''};
  const html=run('handCard(hand,true,true)');
  assert.match(html,/data-open-hand="saved"/);
  assert.doesNotMatch(html,/data-open-library-session|Add a note to remember/);
});

function sessionHistory(run){
  run(`state.sessions=[{id:'previous',game:'NL100',startAt:5000,endAt:15000,captureStartedAt:5000,captureEndedAt:9000,hands:[]}];
    state.activeSession={id:'current',stakes:'NL200',startedAt:10000,hands:[]};`);
}

test("screenshots taken between sessions are discarded rather than imported into the next session",async()=>{
  const {calls,run}=webApp();sessionHistory(run);
  assert.equal(await run("processQueuedScreenshot('gap','data:image/png;base64,test',9500)"),true);
  assert.equal(await run("processQueuedScreenshot('late-old','data:image/png;base64,test',9500,'previous')"),true);
  assert.equal(await run("processQueuedScreenshot('wrong-session','data:image/png;base64,test',8500,'current')"),true);
  assert.equal(await run("saveNativeAnalyzedScreenshot('legacy','data:image/png;base64,test','{}',9500)"),false);
  assert.equal(calls.images.length,0);assert.equal(calls.requests.length,0);
  assert.deepEqual(calls.bridge.map(x=>x.id),['gap','late-old','wrong-session','legacy']);
  assert.equal(run('allHandsLibrary().length'),0);
});

test("queued captures stay with the session in which they were taken, including after that session ends",async()=>{
  const {calls,run}=webApp();sessionHistory(run);
  assert.equal(await run("processQueuedScreenshot('old-shot','data:image/png;base64,test',8500,'previous')"),true);
  assert.equal(run("state.sessions[0].hands[0].sessionId"),'previous');
  assert.equal(run("state.sessions[0].hands[0].status"),'ready');
  assert.equal(run("state.activeSession.hands.length"),0);
  assert.equal(calls.requests[0].body.context.sessionGame,'NL100');
  run("state.activeSession=null; save()");
  assert.equal(await run("processQueuedScreenshot('legacy-in-session','data:image/png;base64,test',8500)"),true);
  assert.equal(run('state.sessions[0].hands.length'),2);
  assert.equal(run('generalHands().length'),0);
});

test("finishing a session during analysis updates its saved hand and never attaches it to the next session",async()=>{
  let finish;
  const {calls,run}=webApp(()=>new Promise(resolve=>{finish=resolve;}));
  run("state.activeSession={id:'first',startedAt:8000,hands:[]}; save()");
  const processing=run("window.innerGameReceiveScreenshot('data:image/png;base64,test','desktop_auto','first')");
  await tick();assert.equal(calls.requests.length,1);
  run(`state.sessions.push({...state.activeSession,captureStartedAt:8000,captureEndedAt:10000,hands:state.activeSession.hands.map(h=>({...h}))});
    state.activeSession=null; save(); state.activeSession={id:'second',startedAt:10000,hands:[]}; save();`);
  finish(pokerResponse());await processing;
  assert.equal(run('state.sessions[0].hands[0].status'),'ready');
  assert.equal(run('state.activeSession.hands.length'),0);
  assert.equal(run('generalHands().length'),0);
});

test("duplicate native queue callbacks do not analyze the same capture twice",async()=>{
  let finish;
  const {calls,run}=webApp(()=>new Promise(resolve=>{finish=resolve;}));sessionHistory(run);
  run("window.innerGameReceiveQueuedScreenshot('queued','data:image/png;base64,test',8500,'previous')");
  run("window.innerGameReceiveQueuedScreenshot('queued','data:image/png;base64,test',8500,'previous')");
  await tick();assert.equal(calls.requests.length,1);assert.equal(calls.images.length,1);
  finish(pokerResponse());await tick();
  assert.equal(run('state.sessions[0].hands.length'),1);
  assert.equal(run('state.sessions[0].hands[0].status'),'ready');
});

async function desktopApp(){
  const calls={scripts:[],watchers:[],hotkeys:{},handlers:{},reads:0,captureRequests:0,timers:new Map()};
  let now=10000,nextTimer=0,mtime=10000;
  const sources=[{display_id:'1',thumbnail:{isEmpty:()=>false,toDataURL:()=> 'data:image/png;base64,test'}}];
  let getSources=async()=>sources;
  const events={};
  const win={
    webContents:{on:(name,fn)=>events[name]=fn,setWindowOpenHandler:()=>{},executeJavaScript:async code=>calls.scripts.push(code)},
    on:(name,fn)=>events[name]=fn,once:()=>{},loadFile:()=>{},show:()=>{}
  };
  function BrowserWindow(){return win;}
  BrowserWindow.getAllWindows=()=>[win];
  const electron={
    app:{whenReady:()=>Promise.resolve(),on:()=>{},getPath:()=>'/test-app-data'},BrowserWindow,nativeTheme:{},Menu:{setApplicationMenu:()=>{}},
    globalShortcut:{register:(name,fn)=>calls.hotkeys[name]=fn},ipcMain:{handle:(name,fn)=>calls.handlers[name]=fn},
    screen:{getPrimaryDisplay:()=>({id:1,bounds:{width:1280,height:720},scaleFactor:1})},
    desktopCapturer:{getSources:()=>{calls.captureRequests++;return getSources();}}
  };
  const fs={
    existsSync:()=>true,statSync:()=>({isDirectory:()=>true,isFile:()=>true,mtimeMs:mtime}),
    readFileSync:()=>{calls.reads++;return Buffer.from('image');},
    watch:(_dir,_options,callback)=>{const watcher={callback,closed:false,close(){this.closed=true;}};calls.watchers.push(watcher);return watcher;}
  };
  const context=vm.createContext({
    require:name=>({electron,path,fs,os:{homedir:()=>'/home/test'},'./hand-jobs.cjs':{createHandJobRunner:()=>({restore(){},deliver(){}})}}[name]),__dirname:'/desktop',process:{platform:'darwin'},console,
    Date:{now:()=>now},setTimeout:callback=>{const id=++nextTimer;calls.timers.set(id,callback);return id;},clearTimeout:id=>calls.timers.delete(id)
  });
  vm.runInContext(desktopSource,context);await tick();
  const setSession=payload=>calls.handlers['innergame:set-auto-screenshot-enabled']({sender:win.webContents},payload);
  return {calls,events,setSession,run:code=>vm.runInContext(code,context),setCapture:fn=>getSources=fn,sources,setTime:time=>now=time,setMtime:time=>mtime=time};
}

test("desktop watchers and hotkey stay idle until an active session and stop when it ends",async()=>{
  const {calls,setSession,run,events}=await desktopApp();
  assert.equal(calls.watchers.length,0);
  assert.equal(await calls.hotkeys['CommandOrControl+Shift+H'](),false);
  assert.equal(calls.captureRequests,0);
  assert.equal(setSession({enabled:true}),false);
  assert.equal(calls.watchers.length,0);
  setSession({enabled:true,sessionId:'active',startedAt:8000});
  assert.equal(calls.watchers.length,3);
  await calls.hotkeys['CommandOrControl+Shift+H']();assert.equal(calls.scripts.length,1);
  assert.match(calls.scripts[0],/'desktop_hotkey', "active"/);
  calls.watchers[0].callback('rename','Screenshot.png');assert.equal(calls.timers.size,1);
  const delayed=[...calls.timers.values()][0];
  setSession({enabled:false});
  assert.equal(calls.watchers.every(w=>w.closed),true);assert.equal(calls.timers.size,0);
  delayed();await tick();assert.equal(calls.reads,0);
  assert.equal(await run("dispatchScreenshotFile('/home/test/Screenshot.png')"),false);
  setSession({enabled:true,sessionId:'next',startedAt:10000});
  events['did-start-loading']();
  assert.equal(await calls.hotkeys['CommandOrControl+Shift+H'](),false);
});

test("desktop ignores delayed callbacks from an old session and screenshots predating the new watcher",async()=>{
  const {calls,setSession,setTime,setMtime,run}=await desktopApp();
  setSession({enabled:true,sessionId:'first',startedAt:8000});
  const oldWatcher=calls.watchers[0];oldWatcher.callback('rename','Screenshot.png');
  const delayed=[...calls.timers.values()][0];
  setSession({enabled:false});setTime(12000);setMtime(11000);
  setSession({enabled:true,sessionId:'second',startedAt:12000});
  oldWatcher.callback('rename','Screenshot.png');delayed();await tick();assert.equal(calls.reads,0);
  assert.equal(await run("dispatchScreenshotFile('/home/test/Screenshot.png')"),false);
  setMtime(12000);await run("dispatchScreenshotFile('/home/test/Screenshot.png')");
  assert.equal(calls.reads,1);assert.equal(calls.scripts.length,1);
  assert.match(calls.scripts[0],/'desktop_auto', "second"/);
});

test("a desktop screen capture finishing after a session change is never delivered to the new session",async()=>{
  const {calls,setSession,setCapture,sources}=await desktopApp();
  let finish;setCapture(()=>new Promise(resolve=>{finish=resolve;}));
  setSession({enabled:true,sessionId:'first',startedAt:8000});
  const capture=calls.hotkeys['CommandOrControl+Shift+H']();
  setSession({enabled:false});setSession({enabled:true,sessionId:'second',startedAt:10000});
  finish(sources);assert.equal(await capture,false);assert.equal(calls.scripts.length,0);
});

test("the desktop preload exposes session control through the matching IPC channel",()=>{
  let exposed;const calls=[];
  const context=vm.createContext({require:()=>({contextBridge:{exposeInMainWorld:(_name,api)=>exposed=api},ipcRenderer:{invoke:(...args)=>calls.push(args)}})});
  vm.runInContext(readFileSync(new URL('../../desktop/preload.cjs',import.meta.url),'utf8'),context);
  const payload={enabled:false,sessionId:'',startedAt:0};exposed.setAutoScreenshotEnabled(payload);
  assert.deepEqual(calls,[['innergame:set-auto-screenshot-enabled',payload]]);
});

