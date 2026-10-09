const STORAGE_KEY = 'innerGame.v5';
const LEGACY_STORAGE_KEYS = ['innerGame.v4','innerGame.v3','innerGame.v2','innerGame.v1'];
const GOALS = ['Stay patient','No results checking','Mark tough spots','Take 3 breaths after big pots','Stick to bankroll','Quit if tilted'];
const defaults = {
  profile: {name:'Shay'},
  sessions: [],
  generalHands: [],
  dismissedHandJobIds: [],
  games:['NL100'],
  rooms:['GG Poker','Live Casino'],
  prep: {
    breathLevel:'beginner', breathWorkout:'focus', goals:['Stay patient','Mark tough spots'], energy:6, focus:7, noise:3,
    environment:{silent:true, distractions:true, water:true}, leak:'', reminder:'', stakes:'NL100',
    stopLoss:'3 buy-ins', length:'90 min', sessionAmount:'', room:'GG Poker', startDate:'', startTime:'', endDate:'', endTime:'',
    handWarmup:{selectedIds:[],answers:{},currentIndex:0,completed:false,skipped:false}
  },
  activeSession: null
};
const state = load();
let syncedScreenshotSessionId;
const queuedScreenshotsProcessing = new Set();
const backgroundHandDeliveries = new Set();
let route = state.activeSession ? 'active' : 'home';
let breathTimer = null;
let breathRemaining = (({beginner:3,intermediate:10,advanced:20})[state.prep.breathLevel]||3)*60;
let breathRunning = false;
let breathLevel = state.prep.breathLevel || 'beginner';
let sessionTicker = null;
let editingSessionId = null;
let breathSoundEnabled = true;
let breathEndAt = 0;
let breathAudio = null;
let breathLastPhase = -1;
let breathWorkout = state.prep.breathWorkout || 'focus';
let pendingDeleteSessionId = null;
let moneyRange = '30';
let moneyGame = 'all';
let pendingCapturedHand = null;
let selectedSessionHandsId = null;
let selectedHandId = null;
let solverReviewHandId = null;
const solverInspectingHandIds = new Set();
let solverPolling = new Set();
let handsFilter = 'all';
let handsSearch = '';
let handReturnRoute = 'handsLibrary';
const HAND_ANALYSIS_API_URL = localStorage.getItem('innerGame.handApiUrl') || 'https://inner-game-production.up.railway.app';
const BREATH_WORKOUTS = {
  focus:{name:'Focus',short:'Box breathing',description:'Steady attention before you play.',phases:[
    {name:'Inhale',duration:4,cls:'inhale',cue:'Breathe in through your nose',fill:'up'},
    {name:'Hold',duration:4,cls:'hold',cue:'Hold gently — no strain',fill:'full'},
    {name:'Exhale',duration:4,cls:'exhale',cue:'Breathe out slowly',fill:'down'},
    {name:'Hold',duration:4,cls:'rest',cue:'Pause before the next breath',fill:'empty'}
  ]},
  relax:{name:'Relax',short:'4-7-8',description:'Long exhale to settle down.',phases:[
    {name:'Inhale',duration:4,cls:'inhale',cue:'Inhale softly through your nose',fill:'up'},
    {name:'Hold',duration:7,cls:'hold',cue:'Hold gently — stay relaxed',fill:'full'},
    {name:'Exhale',duration:8,cls:'exhale',cue:'Slow, complete exhale',fill:'down'}
  ]},
  balance:{name:'Balance',short:'Coherent breathing',description:'Even rhythm for a calm, steady state.',phases:[
    {name:'Inhale',duration:5,cls:'inhale',cue:'Smooth inhale',fill:'up'},
    {name:'Exhale',duration:5,cls:'exhale',cue:'Smooth exhale',fill:'down'}
  ]},
  nostril:{name:'Reset',short:'Alternate nostril',description:'A deliberate left-right breathing reset.',phases:[
    {name:'Left In',duration:4,cls:'inhale',cue:'Close right nostril · inhale left',fill:'up'},
    {name:'Hold',duration:2,cls:'hold',cue:'Close both gently',fill:'full'},
    {name:'Right Out',duration:4,cls:'exhale',cue:'Open right · exhale',fill:'down'},
    {name:'Right In',duration:4,cls:'inhale',cue:'Inhale through the right nostril',fill:'up'},
    {name:'Hold',duration:2,cls:'hold',cue:'Close both gently',fill:'full'},
    {name:'Left Out',duration:4,cls:'exhale',cue:'Open left · exhale',fill:'down'}
  ]}
};

function deepMerge(base, incoming){
  if (!incoming || typeof incoming !== 'object') return structuredClone(base);
  const out = structuredClone(base);
  Object.keys(incoming).forEach(k => {
    if (incoming[k] && typeof incoming[k] === 'object' && !Array.isArray(incoming[k]) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) out[k] = deepMerge(out[k], incoming[k]);
    else out[k] = incoming[k];
  });
  return out;
}
function load(){
  try {
    const raw = localStorage.getItem(STORAGE_KEY) || LEGACY_STORAGE_KEYS.map(k=>localStorage.getItem(k)).find(Boolean);
    return raw ? deepMerge(defaults, JSON.parse(raw)) : structuredClone(defaults);
  } catch { return structuredClone(defaults); }
}
function save(){ syncAutoScreenshotWatcher(); localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
function esc(v=''){ return String(v).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
function money(v){ const n=Number(v)||0; const sign=n>0?'+':n<0?'-':''; return `${sign}$${Math.abs(n).toLocaleString(undefined,{maximumFractionDigits:0})}`; }
function normalizeGameName(v=''){ return String(v).trim().replace(/\s+/g,' '); }
function knownGames(){
  const fromSessions=state.sessions.map(s=>normalizeGameName(s.game)).filter(Boolean);
  const fromState=(state.games||[]).map(normalizeGameName).filter(Boolean);
  return [...new Set([...fromState,...fromSessions])].sort((a,b)=>a.localeCompare(b));
}
function rememberGame(v){
  const game=normalizeGameName(v); if(!game)return;
  state.games=knownGames();
  if(!state.games.some(x=>x.toLowerCase()===game.toLowerCase())) state.games.push(game);
  state.games.sort((a,b)=>a.localeCompare(b)); save();
}
function gameOptionsHTML(){ return knownGames().map(g=>`<option value="${esc(g)}"></option>`).join(''); }
function normalizeRoomName(v=''){ return String(v).trim().replace(/\s+/g,' '); }
function knownRooms(){
  const fromSessions=state.sessions.map(s=>normalizeRoomName(s.room)).filter(Boolean);
  const fromState=(state.rooms||[]).map(normalizeRoomName).filter(Boolean);
  return [...new Set([...fromState,...fromSessions])].sort((a,b)=>a.localeCompare(b));
}
function rememberRoom(v){
  const room=normalizeRoomName(v); if(!room)return;
  state.rooms=knownRooms();
  if(!state.rooms.some(x=>x.toLowerCase()===room.toLowerCase())) state.rooms.push(room);
  state.rooms.sort((a,b)=>a.localeCompare(b)); save();
}
function roomOptionsHTML(){ return knownRooms().map(r=>`<option value="${esc(r)}"></option>`).join(''); }
function pad2(n){return String(n).padStart(2,'0')}
function localDateValue(ms=Date.now()){const d=new Date(ms);return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`}
function localTimeValue(ms=Date.now()){const d=new Date(ms);return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`}
function localDateTimeValue(ms=Date.now()){return `${localDateValue(ms)}T${localTimeValue(ms)}`}
function parseLocalDateTime(v){const d=new Date(v);return Number.isNaN(d.valueOf())?null:d.valueOf()}
function ensurePrepSchedule(){
  const p=state.prep, now=Date.now();
  if(!p.startDate)p.startDate=localDateValue(now);
  if(!p.startTime)p.startTime=localTimeValue(now);
  if(!p.endDate)p.endDate=localDateValue(now+2*3600000);
  if(!p.endTime)p.endTime=localTimeValue(now+2*3600000);
}
function gamificationStats(){
  const ss=state.sessions;
  let xp=0, aStreak=0;
  ss.forEach(s=>{xp+=100; if((s.process||0)>=8)xp+=50; if((s.tilt??10)<=4)xp+=25; if(s.prep?.handWarmup?.completed)xp+=25;});
  for(let i=ss.length-1;i>=0;i--){ if((ss[i].process||0)>=7)aStreak++; else break; }
  const level=Math.floor(xp/500)+1, inLevel=xp%500;
  const achievements=[
    {icon:'✦',name:'First Session',desc:'Log your first session',on:ss.length>=1},
    {icon:'◈',name:'A-Game',desc:'10 strong-process sessions',on:ss.filter(s=>(s.process||0)>=8).length>=10},
    {icon:'⚡',name:'Volume',desc:'50 total hours',on:ss.reduce((a,s)=>a+(s.durationMs||0),0)>=50*3600000},
    {icon:'↗',name:'Comeback',desc:'Recover after a losing session',on:ss.some((s,i)=>i&&ss[i-1].pnl<0&&s.pnl>0)},
    {icon:'◎',name:'Tilt Proof',desc:'5 sessions with tilt ≤ 3',on:ss.filter(s=>(s.tilt??10)<=3).length>=5},
    {icon:'♠',name:'Warm-up Pro',desc:'Complete 10 hand warm-ups',on:ss.filter(s=>s.prep?.handWarmup?.completed).length>=10}
  ];
  return {xp,level,inLevel,progress:inLevel/500,aStreak,achievements};
}
function avg(a){ return a.length ? a.reduce((x,y)=>x+y,0)/a.length : 0; }
function corr(xs,ys){ if(xs.length<3||xs.length!==ys.length)return null; const mx=avg(xs),my=avg(ys); let n=0,dx=0,dy=0; xs.forEach((x,i)=>{const a=x-mx,b=ys[i]-my;n+=a*b;dx+=a*a;dy+=b*b}); return dx&&dy?n/Math.sqrt(dx*dy):null; }
function navigate(to){ route=to; stopBreath(); stopSessionTicker(); render(); window.scrollTo({top:0,behavior:'instant'}); }
function uiIcon(name){
  const paths={
    home:'<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z"/>',
    sessions:'<rect x="4" y="5" width="16" height="16" rx="3"/><path d="M8 3v4m8-4v4M4 10h16m-11 4h6m-6 3h3"/>',
    insights:'<path d="M4 4v16h16m-12-4v-4m5 4V8m5 8V5"/>',
    settings:'<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>',
    play:'<path d="m9 5 11 7-11 7z"/>',stop:'<rect x="6" y="6" width="12" height="12" rx="2"/>',
    arrow:'<path d="M4 12h15m-6-6 6 6-6 6"/>',back:'<path d="m14 5-7 7 7 7"/>',
    breathe:'<path d="M3 8h12a3 3 0 1 0-3-3M3 12h16a3 3 0 1 1-3 3M3 16h6"/>',
    target:'<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r=".8" fill="currentColor"/>',
    cards:'<rect x="8" y="4" width="12" height="16" rx="2"/><path d="m5 5-2 13a2 2 0 0 0 2 2m9-11 3 3-3 3-3-3z"/>',
    plan:'<rect x="5" y="5" width="14" height="16" rx="2"/><path d="M9 5V3h6v2m-6 7 2 2 4-4m-6 7h6"/>',
    bolt:'<path d="m13 2-8 12h7l-1 8 8-12h-7z"/>',
    award:'<circle cx="12" cy="9" r="6"/><path d="m8 14-2 8 6-3 6 3-2-8"/>',
    shield:'<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z"/><path d="m8 11 3 3 5-5"/>',
    search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
    upload:'<path d="M12 16V3m-5 5 5-5 5 5M4 15v5h16v-5"/>',
    download:'<path d="M12 3v13m-5-5 5 5 5-5M4 16v5h16v-5"/>',
    edit:'<path d="m16 3 5 5-12 12H4v-5zm-3 3 5 5"/>',
    trash:'<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
    check:'<path d="m5 12 4 4L19 6"/>',
    spark:'<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z"/>',
    light:'<path d="M9 18h6m-5 3h4m-6-6a7 7 0 1 1 8 0v1H8z"/>'
  };
  return `<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]||paths.target}</svg>`;
}
function symbolIcon(symbol){return uiIcon(({'◌':'breathe','◎':'target','♠':'cards','◉':'shield','▣':'plan','✦':'spark','◈':'award','⚡':'bolt','↗':'insights'})[symbol]||'target');}
function brandLockup(){return `<span class="brand-lockup"><img class="brand-mark" src="brand-icon.png" alt=""><span>inner<span class="brand-word-light">game</span><small>YOUR GAME. YOUR PROCESS.</small></span></span>`;}
function brandBar(){return `<div class="brand-bar"><button class="brand-home" data-nav="home" aria-label="Inner Game home">${brandLockup()}</button><button class="profile-avatar" data-nav="profile" aria-label="Settings">${esc((state.profile?.name||'IG').trim().slice(0,2).toUpperCase())}</button></div>`;}
function tabs(active){
  const items=[['home','home','Home'],['sessions','sessions','Sessions'],['insights','insights','Insights'],['profile','settings','More']];
  const tab=([r,i,l])=>`<button class="tab ${active===r?'active':''}" data-nav="${r}" ${active===r?'aria-current="page"':''}><span class="ti">${uiIcon(i)}</span><span>${l}</span></button>`;
  const left=items.slice(0,2).map(tab).join(''),right=items.slice(2).map(tab).join('');
  const center=state.activeSession
    ? `<button class="tab-create stop" data-finish-session aria-label="End session">${uiIcon('stop')}<span>Finish</span></button>`
    : `<button class="tab-create play" data-start-prep aria-label="Start session">${uiIcon('play')}<span>Play</span></button>`;
  const running=state.activeSession?'<div class="nav-running"><span></span>Session running · <b id="navElapsed">'+formatDuration(Date.now()-state.activeSession.startedAt)+'</b></div>':'';
  return `${running}<nav class="tabs apple-tabs" aria-label="Main navigation"><button class="nav-brand brand-home" data-nav="home" aria-label="Inner Game home">${brandLockup()}</button><div class="nav-items">${left}${center}${right}</div><div class="nav-footnote">Clear mind.<br>Sharper decisions.</div></nav>`;
}
function header(title,sub,back=true){ return `<div class="hero"><div class="topbar">${back?`<button class="back" data-back aria-label="Back">${uiIcon('back')}</button>`:''}<div class="hero-copy"><h1>${title}</h1>${sub?`<p class="subtitle">${sub}</p>`:''}</div></div></div>`; }
function stepper(active){ const labels=['Breathe','Goals','3 Hands','Plan']; return `<div class="stepper four" aria-label="Preparation progress">${labels.map((l,i)=>`<div class="step ${i<active?'done':''} ${i===active?'active':''}" ${i===active?'aria-current="step"':''}><div class="bubble">${i<active?uiIcon('check'):i+1}</div><span>${l}</span></div>`).join('')}</div>`; }
function appShell(content,tab='home'){ return `<main class="app-shell page-flow" data-screen="${esc(route)}">${brandBar()}${content}${tabs(tab)}</main>`; }
function formatDuration(ms){ const total=Math.max(0,Math.floor((Number(ms)||0)/1000)); const h=Math.floor(total/3600), m=Math.floor((total%3600)/60), s=total%60; return h?`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`:`${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`; }
function nativeCall(name,payload={}){
  try{
    if(window.InnerGameNative&&typeof window.InnerGameNative[name]==='function'){ window.InnerGameNative[name](JSON.stringify(payload)); return; }
    if(window.InnerGameDesktop){
      if(name==='captureHand'&&typeof window.InnerGameDesktop.captureHand==='function'){ window.InnerGameDesktop.captureHand(); return; }
      if(name==='notifyHand'&&typeof window.InnerGameDesktop.notifyHand==='function'){ window.InnerGameDesktop.notifyHand(payload); return; }
      if(name==='setAutoScreenshotEnabled'&&typeof window.InnerGameDesktop.setAutoScreenshotEnabled==='function'){ window.InnerGameDesktop.setAutoScreenshotEnabled(payload); return; }
      if(['ackHandJob','cancelHandJobs'].includes(name)&&typeof window.InnerGameDesktop[name]==='function'){window.InnerGameDesktop[name](payload);return;}
    }
    if(window.webkit?.messageHandlers?.innerGame) window.webkit.messageHandlers.innerGame.postMessage({action:name,...payload});
  }catch{}
}
function supportsBackgroundHandJobs(){return typeof window.InnerGameNative?.enqueueHandJob==='function'||typeof window.InnerGameDesktop?.enqueueHandJob==='function';}
function handJobRequestId(){return crypto.randomUUID?.()||`${Date.now()}-${Math.random().toString(36).slice(2)}`;}
async function enqueueBackgroundHandJob(job){
  const request={...job,apiBase:HAND_ANALYSIS_API_URL.replace(/\/$/,'')};
  let response=window.InnerGameNative?.enqueueHandJob
    ?window.InnerGameNative.enqueueHandJob(JSON.stringify(request))
    :await window.InnerGameDesktop.enqueueHandJob(request);
  if(typeof response==='string')response=JSON.parse(response);
  if(!response?.accepted)throw new Error(response?.error||'Could not queue this hand. Your screenshot is saved; try again.');
}
function cancelBackgroundHandJobs(hand,kinds=['Analysis','Reconstruction','Solve']){
  const requestIds=kinds.map(kind=>hand['background'+kind+'Id']).filter(Boolean);
  state.dismissedHandJobIds=[...new Set([...(state.dismissedHandJobIds||[]),...requestIds])].slice(-500);
  kinds.forEach(kind=>{hand['background'+kind+'Id']=null;});
  if(kinds.includes('Reconstruction'))hand.reconstructionStatus='';
  if(requestIds.length)nativeCall('cancelHandJobs',{requestIds});
}
function notifyHandJobReady(kind,hand,error=''){
  const label=kind==='solve'?'GTO solution':'Hand reconstruction';
  nativeCall('notifyHand',{stage:kind+(error?'_failed':'_ready'),title:label+(error?' needs attention':' ready'),
    body:error||'Tap to open your hand.',handId:hand.id,view:kind==='solve'?'solverResult':'solverReview'});
}

const HAND_DB_NAME='innerGame.handImages';
function handDb(){
  return new Promise((resolve,reject)=>{
    const req=indexedDB.open(HAND_DB_NAME,1);
    req.onupgradeneeded=()=>{const db=req.result;if(!db.objectStoreNames.contains('images'))db.createObjectStore('images');};
    req.onsuccess=()=>resolve(req.result); req.onerror=()=>reject(req.error);
  });
}
async function storeHandImage(key,dataUrl){const db=await handDb();return new Promise((resolve,reject)=>{const tx=db.transaction('images','readwrite');tx.objectStore('images').put(dataUrl,key);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});}
async function getHandImage(key){const db=await handDb();return new Promise((resolve,reject)=>{const req=db.transaction('images','readonly').objectStore('images').get(key);req.onsuccess=()=>resolve(req.result||'');req.onerror=()=>reject(req.error);});}
async function resizeScreenshot(dataUrl,max=1280,quality=.78){
  return new Promise(resolve=>{const img=new Image();img.onload=()=>{let w=img.width,h=img.height;if(Math.max(w,h)>max){const s=max/Math.max(w,h);w=Math.round(w*s);h=Math.round(h*s);}const c=document.createElement('canvas');c.width=w;c.height=h;const x=c.getContext('2d');x.drawImage(img,0,0,w,h);resolve(c.toDataURL('image/jpeg',quality));};img.onerror=()=>resolve(dataUrl);img.src=dataUrl;});
}
function allSessionHands(session){return Array.isArray(session?.hands)?session.hands:[];}
function generalHands(){ if(!Array.isArray(state.generalHands))state.generalHands=[]; return state.generalHands; }
function isManualHandSource(source=''){return /share|drop|manual/i.test(String(source));}
function allHandsLibrary(){
  const out=[];
  generalHands().forEach(h=>out.push({...h,_scope:'general',_sessionLabel:'Unassigned'}));
  if(state.activeSession) allSessionHands(state.activeSession).forEach(h=>out.push({...h,_scope:'session',_sessionActive:true,_sessionLabel:'Active session'}));
  state.sessions.forEach(s=>allSessionHands(s).forEach(h=>out.push({...h,_scope:'session',_sessionId:s.id,_sessionLabel:[s.date,s.game].filter(Boolean).join(' · ')})));
  return out.sort((a,b)=>(b.capturedAt||0)-(a.capturedAt||0));
}
function handDisplayTitle(h){return h.tournamentName||h.title||[h.stakes,h.site].filter(Boolean).join(' · ')||'Captured hand';}
function handCardsText(h){return [...(h.heroCards||[]),...(h.board||[])].join(' ');}
function cleanVisibleTournamentText(v=''){
  let s=String(v||'').replace(/\s+/g,' ').trim();
  s=s.replace(/\s*-\s*\d+(?:st|nd|rd|th)?\s*Pla(?:ce)?\b.*$/i,'');
  s=s.replace(/\s*Blinds?\b.*$/i,'');
  s=s.replace(/\s*(?:Next Prize|Prize Jump|My Rank)\b.*$/i,'');
  return s.trim();
}
function normalizeCapturedTitle(parsed, fallback='Captured hand'){
  if(parsed?.gameType==='tournament'){
    const tournament=cleanVisibleTournamentText(parsed.tournamentName||parsed.visibleEventText||'');
    if(tournament)return tournament;
  }
  return String(parsed?.title||parsed?.tournamentName||fallback||'Captured hand').trim();
}
let captureToastTimer;
function captureToast(text,type='ok'){let t=document.getElementById('captureToast');if(!t){t=document.createElement('div');t.id='captureToast';t.setAttribute('role','status');document.body.appendChild(t);}clearTimeout(captureToastTimer);t.className='capture-toast '+type;t.textContent=text;requestAnimationFrame(()=>t.classList.add('show'));captureToastTimer=setTimeout(()=>t.classList.remove('show'),4000);}
function notifyHandStatus(stage,hand){
  const title=stage==='analyzing'?'Poker hand detected':stage==='saved'?'Hand saved':stage==='failed'?'Hand needs attention':'Inner Game';
  const handTitle=hand&&normalizeCapturedTitle(hand,handDisplayTitle(hand));
  const body=stage==='analyzing'
    ? 'Screenshot captured. Analyzing the hand…'
    : stage==='saved'
      ? ((handTitle&&handTitle!=='Analyzing hand…'?handTitle+' · ':'')+(hand?.sessionId?'Saved to this session.':'Saved to Hands.'))
      : 'The screenshot is saved. Tap to retry analysis.';
  nativeCall('notifyHand',{stage,title,body,handId:hand?.id||''});
}
function findHandRecord(id){
  if(state.activeSession){
    const found=allSessionHands(state.activeSession).find(h=>h.id===id);
    if(found)return found;
  }
  for(const session of state.sessions){
    const found=allSessionHands(session).find(h=>h.id===id);
    if(found)return found;
  }
  const general=generalHands().find(h=>h.id===id);
  return general||null;
}
function refreshCaptureUi(){
  if(['active','sessionHands','captureReview','handsLibrary','handDetail'].includes(route))render();
}
async function analyzeStoredHand(handId,dataUrl){
  let hand=findHandRecord(handId);
  if(!hand)return;
  hand.status='analyzing';
  hand.error='';
  save();
  refreshCaptureUi();
  captureToast('Screenshot saved · analyzing…');
  try{
    let contextSession=state.sessions.find(s=>allSessionHands(s).some(h=>h.id===handId));
    if(!contextSession && state.activeSession && allSessionHands(state.activeSession).some(h=>h.id===handId)) contextSession=state.activeSession;
    if(supportsBackgroundHandJobs()){
      cancelBackgroundHandJobs(hand,['Analysis']);
      const requestId=handJobRequestId();hand.backgroundAnalysisId=requestId;save();
      await enqueueBackgroundHandJob({requestId,kind:'analysis',handId,source:hand.source,capturedAt:hand.capturedAt,sessionId:hand.sessionId,
        payload:{imageDataUrl:dataUrl,context:{sessionGame:contextSession?.stakes||contextSession?.game||'',sessionRoom:contextSession?.room||''}}});
      return;
    }
    const requestBody=JSON.stringify({
      imageDataUrl:dataUrl,
      context:{
        sessionGame:contextSession?.stakes||contextSession?.game||'',
        sessionRoom:contextSession?.room||''
      }
    });
    const maxAttempts=hand.source==='android_auto'?2:1;
    let res=null, parsed={}, lastError=null;
    for(let attempt=0;attempt<maxAttempts;attempt++){
      try{
        res=await fetch(HAND_ANALYSIS_API_URL.replace(/\/$/,'')+'/analyze-hand',{
          method:'POST',
          headers:{'Content-Type':'application/json'},
          cache:'no-store',
          body:requestBody
        });
        parsed={};
        try{ parsed=await res.json(); }catch{}
        if(res.ok)break;
        lastError=new Error(parsed?.error||('HTTP '+res.status));
      }catch(error){
        lastError=error;
      }
      if(attempt+1<maxAttempts) await new Promise(resolve=>setTimeout(resolve,180));
    }
    if(!res?.ok) throw lastError||new Error('Analysis request failed');
    hand=findHandRecord(handId);
    if(!hand)return;
    if(!parsed.isPokerHand){
      if(hand.autoCandidate){ removeCapturedHand(hand.id); refreshCaptureUi(); captureToast('Screenshot ignored · not a poker hand'); return; }
      Object.assign(hand,{status:'needs_review',reviewNeeded:true,confidence:Number(parsed.confidence)||0,title:'Unrecognized screenshot',description:'The screenshot is saved, but the poker hand could not be recognized confidently.',uncertainFields:parsed.uncertainFields||[]});
      pendingCapturedHand=hand; save(); refreshCaptureUi(); captureToast('Saved · review needed','error'); return;
    }
    Object.assign(hand,parsed,{
      title:normalizeCapturedTitle(parsed,hand.title),
      tournamentName:cleanVisibleTournamentText(parsed.tournamentName||parsed.visibleEventText||''),
      autoCandidate:false,
      status:'ready',
      error:'',
      reviewNeeded:false
    });
    save();
    refreshCaptureUi();
    if(hand.reviewNeeded){
      pendingCapturedHand=hand;
      captureToast('Hand saved · review recommended');
    }else{
      if(pendingCapturedHand?.id===hand.id)pendingCapturedHand=null;
      captureToast('Hand saved ✓');
      notifyHandStatus('saved',hand);
    }
  }catch(e){
    console.error(e);
    hand=findHandRecord(handId);
    if(!hand)return;
    if(hand.source==='android_auto_pending'){
      hand.status='pending';
      hand.reviewNeeded=false;
      hand.autoCandidate=true;
      hand.error=String(e?.message||'Pending analysis');
      hand.title=hand.title&&hand.title!=='Analyzing hand…'?hand.title:'Captured hand';
      hand.description='Captured. Analysis will retry automatically.';
      save();
      refreshCaptureUi();
      return;
    }
    hand.status='failed';
    hand.reviewNeeded=true;
    hand.error=String(e?.message||'Analysis failed');
    hand.title=hand.title&&hand.title!=='Analyzing hand…'?hand.title:'Captured hand';
    hand.description='Screenshot saved. Analysis failed — tap Retry.';
    save();
    refreshCaptureUi();
    captureToast('Screenshot saved · analysis failed','error');
    notifyHandStatus('failed',hand);
  }
}
async function analyzeCapturedScreenshot(dataUrl,source='native',captureSessionId=''){
  if(!isManualHandSource(source)&&(!state.activeSession||captureSessionId&&captureSessionId!==state.activeSession.id))return false;
  const sessionId=state.activeSession?.id||null;
  const id=crypto.randomUUID?.()||String(Date.now());
  const provisional={
    id,
    source,
    sessionId,
    capturedAt:Date.now(),
    imageKey:'hand:'+id,
    status:'analyzing',
    reviewNeeded:false,
    title:'Analyzing hand…',
    description:'Screenshot saved. Analysis in progress.',
    confidence:0,
    heroCards:[],
    board:[],
    uncertainFields:[],
    autoCandidate:!isManualHandSource(source)
  };
  try{
    captureToast('Screenshot captured · processing…');
    if(source!=='android_auto'&&!supportsBackgroundHandJobs()) notifyHandStatus('analyzing',provisional);
    const compact=await resizeScreenshot(dataUrl,1120,.74);
    await storeHandImage(provisional.imageKey,compact);
    if(!saveCapturedHand(provisional))return false;
    refreshCaptureUi();
    await analyzeStoredHand(id,compact);
    return true;
  }catch(e){
    console.error(e);
    captureToast('Could not save screenshot.','error');
    return false;
  }
}
function saveCapturedHand(hand){
  const explicitSession=Object.prototype.hasOwnProperty.call(hand,'sessionId');
  const session=explicitSession
    ?(hand.sessionId===state.activeSession?.id?state.activeSession:state.sessions.find(s=>s.id===hand.sessionId))
    :state.activeSession;
  if(explicitSession&&hand.sessionId&&!session)return false;
  if(session&&!session.id)session.id=crypto.randomUUID?.()||String(Date.now());
  const sessionId=session?.id||null;
  const hands=session?(session.hands=allSessionHands(session)):generalHands();
  const existing=hands.find(x=>x.id===hand.id);
  const saved=existing||{...hand,sessionId,userEdited:Boolean(hand.userEdited)};
  if(existing)Object.assign(existing,hand,{sessionId});
  else hands.push(saved);
  save();
  return saved;
}
function removeCapturedHand(id){
  const hand=findHandRecord(id);if(hand)cancelBackgroundHandJobs(hand);
  if(state.activeSession)state.activeSession.hands=allSessionHands(state.activeSession).filter(h=>h.id!==id);
  state.sessions.forEach(s=>{if(Array.isArray(s.hands))s.hands=s.hands.filter(h=>h.id!==id);});
  state.generalHands=generalHands().filter(h=>h.id!==id);
  save();
}
function automaticCaptureSession(sessionId,capturedAt){
  const sessions=[state.activeSession,...state.sessions].filter(Boolean);
  const timestamp=Number(capturedAt);
  if(!Number.isFinite(timestamp)||timestamp<=0)return null;
  return sessions.find(session=>{
    const start=Number(session.captureStartedAt||session.startedAt||session.startAt),end=session===state.activeSession?Date.now():Number(session.captureEndedAt||session.endAt);
    return (!sessionId||session.id===sessionId)&&start>0&&timestamp>=start&&timestamp<=end;
  })||null;
}
async function saveNativeAnalyzedScreenshot(id,dataUrl,analysisJson,capturedAt,sessionId){
  const existing=findHandRecord(id),session=automaticCaptureSession(sessionId||existing?.sessionId,capturedAt||existing?.capturedAt);
  if(!session){nativeCall('ackNativeAnalysis',{id});return false;}
  let parsed={};
  try{ parsed=JSON.parse(analysisJson||'{}'); }catch{ parsed={__error:'Invalid analysis response'}; }

  const failed=Boolean(parsed.__error);
  const hand={
    id,
    source:'android_auto',
    sessionId:session.id,
    capturedAt:Number(capturedAt)||existing?.capturedAt||Date.now(),
    imageKey:'hand:'+id,
    status:failed?'failed':'ready',
    reviewNeeded:failed,
    title:failed?'Captured hand':normalizeCapturedTitle(parsed,parsed.title||'Captured hand'),
    description:failed?'Screenshot saved. Analysis failed — tap Retry.':(parsed.description||''),
    confidence:Number(parsed.confidence)||0,
    heroCards:Array.isArray(parsed.heroCards)?parsed.heroCards:[],
    board:Array.isArray(parsed.board)?parsed.board:[],
    uncertainFields:Array.isArray(parsed.uncertainFields)?parsed.uncertainFields:[],
    autoCandidate:false,
    error:failed?String(parsed.__error||'Analysis failed'):''
  };

  if(!failed){
    Object.assign(hand,parsed,{
      id,
      source:'android_auto',
      capturedAt:hand.capturedAt,
      imageKey:hand.imageKey,
      title:normalizeCapturedTitle(parsed,hand.title),
      tournamentName:cleanVisibleTournamentText(parsed.tournamentName||parsed.visibleEventText||''),
      autoCandidate:false,
      status:'ready',
      error:'',
      reviewNeeded:false
    });
  }

  try{
    await storeHandImage(hand.imageKey,dataUrl);
    saveCapturedHand(hand);
    refreshCaptureUi();
    if(failed) captureToast('Screenshot saved · analysis failed','error');
    else captureToast('Hand saved ✓');
    nativeCall('ackNativeAnalysis',{id});
  }catch(error){
    console.error(error);
    // Do not acknowledge: Android keeps the pending result and retries on resume.
  }
}

window.innerGameReceiveScreenshot=(dataUrl,source='native',sessionId='')=>analyzeCapturedScreenshot(dataUrl,source,sessionId);

async function processQueuedScreenshot(id,dataUrl,capturedAt,sessionId=''){
  const existing=findHandRecord(id);
  const session=automaticCaptureSession(sessionId||existing?.sessionId,capturedAt);
  if(!session){nativeCall('ackNativeAnalysis',{id});return true;}
  let hand=existing||{
    id,
    source:'android_auto_pending',
    sessionId:session.id,
    capturedAt:Number(capturedAt)||Date.now(),
    imageKey:'hand:'+id,
    status:'analyzing',
    reviewNeeded:false,
    title:'Analyzing hand…',
    description:'',
    confidence:0,
    heroCards:[],
    board:[],
    uncertainFields:[],
    autoCandidate:true
  };

  try{
    const compact=await resizeScreenshot(dataUrl,1120,.74);
    await storeHandImage(hand.imageKey,compact);
    hand=saveCapturedHand({...hand,sessionId:session.id});
    if(!hand){nativeCall('ackNativeAnalysis',{id});return true;}

    // Foreground/WebView networking is the reliable path on this device.
    // Keep this silent: no system "analysis failed" notification for temporary connectivity.
    let contextSession=state.sessions.find(s=>allSessionHands(s).some(h=>h.id===id));
    if(!contextSession && state.activeSession && allSessionHands(state.activeSession).some(h=>h.id===id)) contextSession=state.activeSession;
    const requestBody=JSON.stringify({
      imageDataUrl:compact,
      context:{
        sessionGame:contextSession?.stakes||contextSession?.game||'',
        sessionRoom:contextSession?.room||''
      }
    });

    let res=null, parsed={}, lastError=null;
    for(let attempt=0;attempt<3;attempt++){
      try{
        res=await fetch(HAND_ANALYSIS_API_URL.replace(/\/$/,'')+'/analyze-hand',{
          method:'POST',
          headers:{'Content-Type':'application/json'},
          cache:'no-store',
          body:requestBody
        });
        parsed={};
        try{ parsed=await res.json(); }catch{}
        if(res.ok)break;
        lastError=new Error(parsed?.error||('HTTP '+res.status));
      }catch(error){ lastError=error; }
      if(attempt<2) await new Promise(resolve=>setTimeout(resolve,400*(attempt+1)));
    }

    hand=findHandRecord(id);
    if(!hand){nativeCall('ackNativeAnalysis',{id});return true;}
    if(!res?.ok){
      hand.status='pending';
      hand.reviewNeeded=false;
      hand.autoCandidate=true;
      hand.error=String(lastError?.message||'Pending analysis');
      save();
      return false; // no ack: retry automatically on next app foreground
    }

    if(!parsed.isPokerHand){
      removeCapturedHand(id);
      nativeCall('ackNativeAnalysis',{id});
      return true;
    }

    Object.assign(hand,parsed,{
      id,
      source:'android_auto',
      capturedAt:hand.capturedAt,
      imageKey:hand.imageKey,
      title:normalizeCapturedTitle(parsed,hand.title),
      tournamentName:cleanVisibleTournamentText(parsed.tournamentName||parsed.visibleEventText||''),
      autoCandidate:false,
      status:'ready',
      error:'',
      reviewNeeded:false
    });
    save();
    refreshCaptureUi();
    nativeCall('ackNativeAnalysis',{id});
    return true;
  }catch(error){
    console.error(error);
    hand=findHandRecord(id);
    if(!hand)return false;
    hand.status='pending';
    hand.reviewNeeded=false;
    hand.autoCandidate=true;
    hand.error=String(error?.message||'Pending analysis');
    save();
    return false;
  }
}

window.innerGameReceiveQueuedScreenshot=(id,dataUrl,capturedAt,sessionId='')=>{
  if(queuedScreenshotsProcessing.has(id))return true;
  queuedScreenshotsProcessing.add(id);
  processQueuedScreenshot(id,dataUrl,capturedAt,sessionId).finally(()=>queuedScreenshotsProcessing.delete(id));
  return true;
};

window.innerGameReceiveNativeAnalysis=(id,dataUrl,analysisJson,capturedAt,sessionId='')=>{
  saveNativeAnalyzedScreenshot(id,dataUrl,analysisJson,capturedAt,sessionId);
  return true;
};
window.innerGameOpenHand=(id,view='handDetail')=>{
  const hand=findHandRecord(id);
  if(!hand)return false;
  selectedHandId=id;
  handReturnRoute='handsLibrary';
  if(view==='solverResult'||view==='solverReview')solverReviewHandId=id;
  navigate(['solverResult','solverReview'].includes(view)?view:'handDetail');
  return true;
};
window.innerGameReceiveBackgroundCapture=async(id,dataUrl,capturedAt,sessionId,requestId)=>{
  if((state.dismissedHandJobIds||[]).includes(requestId))return false;
  const session=automaticCaptureSession(sessionId,capturedAt);
  if(!session){nativeCall('ackHandJob',{requestId});nativeCall('ackNativeAnalysis',{id});return false;}
  let hand=findHandRecord(id);
  if(!hand){
    await storeHandImage('hand:'+id,dataUrl);
    if((state.dismissedHandJobIds||[]).includes(requestId)||!automaticCaptureSession(sessionId,capturedAt))return false;
    hand=findHandRecord(id)||saveCapturedHand({id,source:'android_auto',sessionId:session.id,capturedAt,imageKey:'hand:'+id,
      status:'analyzing',title:'Analyzing hand…',description:'Processing in the background.',heroCards:[],board:[],uncertainFields:[],
      autoCandidate:true,backgroundAnalysisId:requestId});
  }
  nativeCall('ackNativeAnalysis',{id});refreshCaptureUi();
  return Boolean(hand);
};
window.innerGameReceiveHandJob=async input=>{
  const job=typeof input==='string'?JSON.parse(input):input;
  const requestId=job?.requestId;
  if(!requestId||!['complete','failed'].includes(job.status))return false;
  if(backgroundHandDeliveries.has(requestId))return false;
  backgroundHandDeliveries.add(requestId);
  try{
    if((state.dismissedHandJobIds||[]).includes(requestId)){nativeCall('ackHandJob',{requestId});return true;}
    let hand=findHandRecord(job.handId);
    if(!hand&&job.kind==='analysis'&&job.source==='android_auto'){
      await window.innerGameReceiveBackgroundCapture(job.handId,job.payload?.imageDataUrl,job.capturedAt,job.sessionId,requestId);
      hand=findHandRecord(job.handId);
    }
    const field={analysis:'backgroundAnalysisId',reconstruction:'backgroundReconstructionId',solve:'backgroundSolveId'}[job.kind];
    if(!hand||!field||hand[field]!==requestId){nativeCall('ackHandJob',{requestId});return true;}
    const result=job.result||{},invalid=job.status==='complete'&&(
      job.kind==='analysis'?typeof result.isPokerHand!=='boolean':
      job.kind==='reconstruction'?!result.spot:!result.solution);
    const failed=job.status==='failed'||invalid,message=invalid?'The result was incomplete. Your hand is saved; tap Retry.':job.error?.message||'Processing failed. Your hand is saved; tap Retry.';
    if(job.kind==='analysis'){
      if(!failed&&!result.isPokerHand&&hand.autoCandidate){removeCapturedHand(hand.id);nativeCall('ackHandJob',{requestId});refreshCaptureUi();return true;}
      const recognized=!failed&&Boolean(result.isPokerHand);
      Object.assign(hand,failed?{}:result,{id:hand.id,sessionId:hand.sessionId,capturedAt:hand.capturedAt,imageKey:hand.imageKey,
        title:recognized?normalizeCapturedTitle(result,hand.title):failed?'Captured hand':'Unrecognized screenshot',
        tournamentName:recognized?cleanVisibleTournamentText(result.tournamentName||result.visibleEventText||''):'',
        status:failed?'failed':recognized?'ready':'needs_review',reviewNeeded:failed||!recognized,autoCandidate:false,error:failed?message:''});
    }else if(job.kind==='reconstruction'){
      hand.reconstructionStatus=failed?'failed':'ready';hand.solverError=failed?message:'';
      if(!failed){hand.solverSpot=result.spot;hand.solverSpotVersion=7;hand.solverResult=null;hand.solverJob=null;hand.solverStatus='';}
    }else{
      const preparedSpot=job.payload?.spot||result.spot;
      if(preparedSpot){hand.solverSpot=preparedSpot;hand.solverSpotVersion=7;}
      hand.solverStatus=failed?'failed':'solved';hand.solverError=failed?message:'';hand.solverJob=null;
      if(!failed)hand.solverResult=result.solution;
      const missing=job.error?.payload?.missingFields||job.error?.payload?.missing;
      if(failed&&Array.isArray(missing)&&hand.solverSpot)hand.solverSpot.missingFields=missing;
    }
    hand[field]=null;save();nativeCall('ackHandJob',{requestId});
    if(job.kind==='reconstruction'&&!failed)await continueHandSolve(hand);
    if(['active','handDetail','handsLibrary','sessionHands','solverReview','solverResult'].includes(route))render();
    return true;
  }finally{backgroundHandDeliveries.delete(requestId);}
};
function captureReview(){
  const h=pendingCapturedHand;if(!h){route='active';return activeSession();}
  return appShell(`${header('Review <span class="accent">Hand</span>','Check the extracted details before saving.')}
  <section class="card pad capture-review">
    <img data-hand-image-key="${esc(h.imageKey)}" class="capture-review-image" alt="Captured poker hand">
    <div class="capture-fields">
      ${captureField('Title','title',h.title)}${captureField('Site','site',h.site)}${captureField('Stakes / blinds','stakes',h.stakes||h.blinds)}
      ${captureField('Position','heroPosition',h.heroPosition)}${captureField('Hero cards','heroCards',(h.heroCards||[]).join(' '))}
      ${captureField('Board','board',(h.board||[]).join(' '))}${captureField('Pot','pot',h.pot)}
      <div class="field"><label>Description</label><textarea data-capture-field="description">${esc(h.description||'')}</textarea></div>
    </div>
    <div class="confidence-note">Confidence: ${Math.round((h.confidence||0)*100)}%${h.uncertainFields?.length?' · Check: '+esc(h.uncertainFields.join(', ')):''}</div>
  </section>
  <button class="btn primary" data-save-capture>Save Changes</button>
  <button class="btn ghost danger-text" data-discard-capture>Delete Hand</button>`,'sessions');
}
function captureField(label,key,value){return `<div class="field"><label>${label}</label><input type="text" data-capture-field="${key}" value="${esc(value||'')}"></div>`;}
function selectedHand(){return selectedHandId?findHandRecord(selectedHandId):null;}
function pokerCardChip(card){
  if(!card)return '';
  const c=String(card), suit=c.slice(-1).toLowerCase(), red=suit==='h'||suit==='d'||c.includes('♥')||c.includes('♦');
  return `<span class="poker-card-chip ${red?'red':''}">${esc(c)}</span>`;
}

function handStatusInfo(h){
  const status=h?.status||'ready';
  if(status==='analyzing'||status==='pending'||h?.autoCandidate)return {status:'pending',label:'Processing'};
  if(status==='failed')return {status:'failed',label:'Analysis failed'};
  if(h?.reviewNeeded)return {status:'review',label:'Review'};
  return {status:'ready',label:'Saved'};
}
function handSessionContext(h){
  if(!h)return null;
  if(state.activeSession && (h.sessionId===state.activeSession.id || allSessionHands(state.activeSession).some(x=>x.id===h.id))){
    return {id:'active',label:'Active session',session:state.activeSession};
  }
  const s=state.sessions.find(s=>h.sessionId===s.id || allSessionHands(s).some(x=>x.id===h.id));
  return s?{id:s.id,label:[s.date,s.game].filter(Boolean).join(' · '),session:s}:null;
}
function handDetail(){
  const h=selectedHand();
  if(!h){route='handsLibrary';return handsLibrary();}
  const statusInfo=handStatusInfo(h);
  const title=normalizeCapturedTitle(h,handDisplayTitle(h));
  const sessionCtx=handSessionContext(h);
  const meta=[h.site,h.blinds||h.stakes].filter(Boolean);
  return appShell(`${header('<span class="accent">Hand</span>','')}
    <section class="hand-b-hero card">
      <img data-hand-image-key="${esc(h.imageKey)}" alt="Poker hand screenshot">
    </section>
    <section class="hand-b-title">
      <div class="hand-kind">${h.gameType==='tournament'?'TOURNAMENT':'POKER HAND'}</div>
      <h2>${esc(title)}</h2>
      <div class="hand-b-meta">
        ${meta.map(x=>`<span>${esc(x)}</span>`).join('')}
        <span>${new Date(h.capturedAt||Date.now()).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}</span>
        ${sessionCtx?`<span>${esc(sessionCtx.label)}</span>`:''}
        <span class="hand-status ${esc(statusInfo.status)}">${esc(statusInfo.label)}</span>
      </div>
    </section>
    ${statusInfo.status==='pending'?'<div class="hand-processing-strip"><span class="processing-dot"></span><div><strong>Processing hand</strong><small>This will update automatically.</small></div></div>':''}
    <section class="card pad hand-notes-card">
      <div class="row between"><small class="eyebrow">NOTES</small><span class="notes-saved-hint" id="notesSavedHint"></span></div>
      <textarea id="handNotes" aria-label="Hand notes" placeholder="What made this hand worth saving?">${esc(h.notes||'')}</textarea>
      <button class="btn primary hand-notes-save" data-save-hand-notes="${esc(h.id)}">Save Notes</button>
    </section>
    <div class="hand-detail-actions">
      ${statusInfo.status==='failed'?`<button class="btn primary" data-retry-hand="${esc(h.id)}">Retry Analysis</button>`:''}
      <button class="btn primary solver-primary-btn" data-solve-hand="${esc(h.id)}">${h.solverResult?'View GTO solution':h.solverStatus==='pending'?'Solver running…':'Solve this hand'} <span>›</span></button>
      <button class="btn secondary" data-edit-hand="${esc(h.id)}">Edit Details</button>
      <button class="btn ghost danger-text" data-delete-hand="${esc(h.id)}">Delete Hand</button>
    </div>`,'sessions');
}

const SOLVER_DEBUG_BUILD=true;
function solverDebugAdd(hand,stage,data={}){
  if(!hand)return;
  if(!Array.isArray(hand.solverDebug))hand.solverDebug=[];
  hand.solverDebug.push({at:new Date().toISOString(),stage,data});
  if(hand.solverDebug.length>80)hand.solverDebug=hand.solverDebug.slice(-80);
  save();
}
function solverDebugText(hand){
  return JSON.stringify({
    build:"solver-debug-v1",
    handId:hand?.id||"",
    title:hand?.title||"",
    solverStatus:hand?.solverStatus||"",
    solverError:hand?.solverError||"",
    spotVersion:hand?.solverSpotVersion||0,
    spot:hand?.solverSpot||null,
    job:hand?.solverJob?{provider:hand.solverJob.provider,decisionStreet:hand.solverJob.decisionStreet,heroHand:hand.solverJob.heroHand,expectedSegments:hand.solverJob.expectedSegments,debugRequestId:hand.solverJob.debugRequestId}:null,
    events:hand?.solverDebug||[]
  },null,2);
}
function solverDebugPanel(hand){
  if(!SOLVER_DEBUG_BUILD)return "";
  const count=(hand?.solverDebug||[]).length;
  const errorBadge=hand?.solverError?'<span class="negative">error</span>':'';
  return '<details class="card pad solver-debug-card"><summary>Solver diagnostics</summary>'+
    '<div class="row between"><div><small class="eyebrow">DEBUG BUILD</small><div class="section-title">Solver trace</div></div><button class="btn tiny secondary" data-copy-solver-debug>Copy trace</button></div>'+
    '<div class="solver-debug-summary"><span>'+count+' events</span><span>'+esc(hand?.solverStatus||'idle')+'</span>'+errorBadge+'</div>'+
    '<pre id="solverDebugOutput">'+esc(solverDebugText(hand))+'</pre>'+
  '</details>';
}
function solverHand(){ return solverReviewHandId?findHandRecord(solverReviewHandId):selectedHand(); }
function solverActionLines(actions=[]){
  return actions.map(a=>[a.street,a.position,a.action,Number(a.amountBb)||0,Number(a.sizePctPot)||0].join(' | ')).join('\n');
}
function parseSolverActionLines(text=''){
  return String(text).split(/\n+/).map(x=>x.trim()).filter(Boolean).map(line=>{
    const p=line.split('|').map(x=>x.trim());
    return {
      street:(p[0]||'preflop').toLowerCase(),
      position:(p[1]||'').toUpperCase(),
      action:(p[2]||'unknown').toLowerCase(),
      amountBb:p[3]?.trim()?Number(p[3]):0,
      sizePctPot:p[4]?.trim()?Number(p[4]):0
    };
  });
}
function solverLocalHistoryIssues(spot){
  const issues=[];
  const rows=Array.isArray(spot?.actionHistory)?spot.actionHistory:[];
  const pre=rows.filter(a=>a.street==='preflop');
  if(pre.length<2||pre[0]?.action!=='small_blind'||String(pre[0]?.position||'').toUpperCase()!=='SB'||pre[1]?.action!=='big_blind'||String(pre[1]?.position||'').toUpperCase()!=='BB'){
    issues.push('Action history must start with SB and BB blind posts');
  }
  if(rows.some(a=>a.action==='unknown'))issues.push('Action history contains an unknown action');
  if(rows.some(a=>!['preflop','flop','turn','river'].includes(a.street)))issues.push('Action history contains an invalid street');
  if(rows.some(a=>a.amountBb!==undefined&&(!Number.isFinite(a.amountBb)||a.amountBb<0)))issues.push('Action history contains an invalid amount');
  if(rows.some(a=>['bet','donk_bet','raise','allin'].includes(a.action)&&a.amountBb!==undefined&&!(a.amountBb>0)))issues.push('Bet and raise amounts must be greater than zero');
  const hero=String(spot?.heroPosition||'').toUpperCase(), villain=String(spot?.villainPosition||'').toUpperCase();
  for(const street of ['flop','turn','river']){
    const actions=rows.filter(a=>a.street===street);
    if(!actions.length)continue;
    let outstanding=false,terminal=false,lastActor='',checks=0;
    for(const a of actions){
      const actor=String(a.position||'').toUpperCase();
      if(hero&&villain&&actor!==hero&&actor!==villain){issues.push(street+': action belongs to a player who should already be out of the hand');break;}
      if(terminal){issues.push(street+': action appears after the betting round ended');break;}
      if(lastActor&&actor===lastActor){issues.push(street+': the same player acts twice in a row');break;}
      if(a.action==='check'){
        if(outstanding){issues.push(street+': check while facing a bet');break;}
        checks++;if(checks>=2)terminal=true;
      }else if(a.action==='bet'||a.action==='donk_bet'){
        if(outstanding){issues.push(street+': bet while a bet is already outstanding');break;}
        outstanding=true;checks=0;
      }else if(a.action==='allin'){
        outstanding=true;checks=0;
      }else if(a.action==='raise'){
        if(!outstanding){issues.push(street+': raise without a prior bet');break;}
        outstanding=true;checks=0;
      }else if(a.action==='call'){
        if(!outstanding){issues.push(street+': call without a bet to call');break;}
        outstanding=false;terminal=true;checks=0;
      }else if(a.action==='fold'){
        if(!outstanding){issues.push(street+': fold without a bet to fold to');break;}
        terminal=true;checks=0;
      }
      lastActor=actor;
    }
    if(street!==spot.decisionStreet&&actions.length&&!terminal)issues.push(street+': betting round is incomplete');
  }
  return [...new Set(issues)];
}
function solverLocalPreflopRangeIssues(spot){
  if(!spot||spot.decisionStreet==='preflop')return [];
  const rows=(Array.isArray(spot.actionHistory)?spot.actionHistory:[]).filter(a=>a.street==='preflop');
  const issues=[];
  for(const pos of [spot.heroPosition,spot.villainPosition].map(x=>String(x||'').toUpperCase()).filter(Boolean)){
    const actions=rows.filter(a=>String(a.position||'').toUpperCase()===pos&&!['small_blind','big_blind'].includes(a.action));
    const chosen=actions.at(-1);
    if(!chosen)issues.push('Missing final preflop action for '+pos);
    else if(!['call','raise','allin'].includes(chosen.action))issues.push('Unsupported final preflop action for '+pos+': '+chosen.action);
  }
  return issues;
}
function solverMissing(spot){
  if(!spot)return ['Hand details'];
  const missing=[];
  if(spot.game!=='NLH')missing.push('No-limit Hold’em');
  if(!(Number(spot.tableSize)>=3&&Number(spot.tableSize)<=6))missing.push('Current solver provider supports 3–6 handed NLH');
  if(!spot.heroPosition)missing.push('Hero position');
  if(!spot.decisionStreet||spot.decisionStreet==='unknown')missing.push('Decision street');
  if(!Array.isArray(spot.heroCards)||spot.heroCards.length!==2)missing.push('Hero cards');
  const need={flop:3,turn:4,river:5}[spot.decisionStreet]||0;
  if(need && (!Array.isArray(spot.board)||spot.board.length<need))missing.push('Board');
  if(!spot.actionHistoryComplete)missing.push('Complete action history from preflop to this decision');
  missing.push(...solverLocalHistoryIssues(spot));
  missing.push(...solverLocalPreflopRangeIssues(spot));
  if(spot.decisionStreet!=='preflop'){
    if(!spot.villainPosition)missing.push('Villain position');
    if(!(Number(spot.flopStartPotBb)>0))missing.push('Pot entering flop');
    if(!(Number(spot.flopStartEffectiveStackBb)>0))missing.push('Effective stack entering flop');
  }
  return [...new Set([...(spot.missingFields||[]),...missing])];
}
function solverField(label,key,value,type='text',step='any'){
  return `<div class="field solver-field"><label>${label}</label><input data-solver-field="${key}" type="${type}" ${type==='number'?`min="0" step="${step}" inputmode="decimal"`:''} value="${esc(value??'')}"></div>`;
}
function solverSelect(label,key,value,options){
  return `<div class="field solver-field"><label>${label}</label><select data-solver-field="${key}">${options.map(([v,l])=>`<option value="${esc(v)}" ${String(value)===String(v)?'selected':''}>${esc(l)}</option>`).join('')}</select></div>`;
}
function solverRangeSummary(spot){
  if(spot?.decisionStreet==='preflop')return '<section class="card pad solver-range-summary"><strong>GTO preflop strategy · Automatic</strong><p>We select the available chart for your position, stack and action history.</p></section>';
  return `<section class="card pad solver-range-summary"><div class="row between"><strong>GTO-based ranges</strong><span class="solver-range-badge">Automatic</span></div>
    <div class="solver-range-players"><div><small>HERO ${esc(spot?.heroPosition||'')}</small><strong>Your continuing range</strong></div><div><small>VILLAIN ${esc(spot?.villainPosition||'')}</small><strong>Opponent’s continuing range</strong></div></div>
    <p>Both ranges come from the solver’s preflop charts and each player’s actions. No range entry needed.</p>
    <details><summary>Range assumptions</summary><p>Uses the nearest available 40 BB or 100 BB 6-max chart, then your postflop pot and stack. Tournament hands use chip EV, without ICM adjustments.</p></details></section>`;
}
function solverVisibleIssues(spot){
  return [...new Set(solverMissing(spot).map(issue=>{
    if(/action|preflop|blind post|betting|bet |raise |call |fold |check |player|street:/i.test(issue))return 'A clear betting history up to your decision';
    if(/flop|pot|stack/i.test(issue))return 'Visible pot and stack sizes';
    if(/card|board/i.test(issue))return 'Readable hero cards and board';
    return issue;
  }))];
}
async function continueHandSolve(hand){
  if(!hand.solverAutoRun)return;
  hand.solverAutoRun=false;save();
  const visible=solverReviewHandId===hand.id&&['solverReview','solverResult'].includes(route);
  if(solverMissing(hand.solverSpot).length){if(visible){route='solverReview';render();}return;}
  await runSolverForHand(hand.id,{background:!visible});
}
async function startHandSolve(id,force=false){
  const hand=findHandRecord(id);if(!hand)return;
  solverReviewHandId=id;selectedHandId=id;
  if(['starting','pending'].includes(hand.solverStatus)){navigate('solverResult');return;}
  if(hand.solverResult&&!force&&solverResultMatchesSpot(hand.solverResult,hand.solverSpot)){navigate('solverResult');return;}
  if(force){cancelBackgroundHandJobs(hand,['Reconstruction','Solve']);hand.solverSpot=null;hand.solverSpotVersion=0;}
  hand.solverAutoRun=true;hand.solverError='';save();
  if(hand.solverSpot&&hand.solverSpotVersion>=7){navigate('solverReview');await continueHandSolve(hand);return;}
  // Android owns both stages so closing the WebView cannot pause a solve after
  // reconstruction. Existing reconstruction jobs can still complete normally.
  if(typeof window.InnerGameNative?.enqueueHandJob==='function'&&!hand.backgroundReconstructionId){
    const requestId=handJobRequestId();hand.backgroundSolveId=requestId;hand.solverStatus='starting';hand.solverResult=null;hand.solverAutoRun=false;save();navigate('solverResult');
    try{
      const imageDataUrl=await getHandImage(hand.imageKey);
      if(findHandRecord(id)?.backgroundSolveId!==requestId)return;
      if(!imageDataUrl)throw new Error('Screenshot image is missing.');
      await enqueueBackgroundHandJob({requestId,kind:'solve',handId:id,payload:{imageDataUrl,hand:{title:hand.title,gameType:hand.gameType,site:hand.site,stakes:hand.stakes||hand.blinds,heroPosition:hand.heroPosition,heroCards:hand.heroCards,board:hand.board,pot:hand.pot,actionSummary:hand.actionSummary}}});
      if(hand.backgroundSolveId===requestId){hand.solverStatus='pending';save();render();}
    }catch(error){
      if(hand.backgroundSolveId!==requestId)return;
      hand.backgroundSolveId=null;hand.solverStatus='failed';hand.solverError=String(error?.message||error);save();render();
    }
    return;
  }
  await inspectHandForSolver(id,force);
}
async function inspectHandForSolver(id,force=false){
  const hand=findHandRecord(id); if(!hand)return;
  if(solverInspectingHandIds.has(id)){navigate('solverReview');return;}
  solverReviewHandId=id;
  if(hand.backgroundReconstructionId&&hand.reconstructionStatus==='pending'&&!force){navigate('solverReview');return;}
  if(hand.solverSpot&&hand.solverSpotVersion>=7&&!force){ navigate('solverReview'); return; }
  cancelBackgroundHandJobs(hand,['Reconstruction','Solve']);
  hand.solverResult=null;hand.solverJob=null;hand.solverStatus='';
  if(supportsBackgroundHandJobs()){hand.backgroundReconstructionId=handJobRequestId();hand.reconstructionStatus='pending';}
  const backgroundId=hand.backgroundReconstructionId;
  save();
  route='solverReview'; solverInspectingHandIds.add(id); solverDebugAdd(hand,'inspect:start',{force,spotVersion:hand.solverSpotVersion||0}); render();
  try{
    const imageDataUrl=await getHandImage(hand.imageKey);
    if(!imageDataUrl)throw new Error('Screenshot image is missing.');
    if(backgroundId){
      if(findHandRecord(id)?.backgroundReconstructionId!==backgroundId)return;
      await enqueueBackgroundHandJob({requestId:backgroundId,kind:'reconstruction',handId:id,payload:{imageDataUrl,hand:{title:hand.title,
        gameType:hand.gameType,site:hand.site,stakes:hand.stakes||hand.blinds,heroPosition:hand.heroPosition,heroCards:hand.heroCards,board:hand.board,pot:hand.pot,actionSummary:hand.actionSummary}}});
      return;
    }
    const apiBase=HAND_ANALYSIS_API_URL.replace(/\/$/,'');
    let res=await fetch(apiBase+'/solver/inspect',{
      signal:AbortSignal.timeout(30_000),
      method:'POST',headers:{'Content-Type':'application/json'},cache:'no-store',
      body:JSON.stringify({imageDataUrl,async:true,hand:{
        title:hand.title,gameType:hand.gameType,site:hand.site,stakes:hand.stakes||hand.blinds,
        heroPosition:hand.heroPosition,heroCards:hand.heroCards,board:hand.board,pot:hand.pot,
        actionSummary:hand.actionSummary
      }})
    });
    let json=await res.json().catch(()=>({}));
    if(res.status===202&&json.inspectionId){
      const inspectionId=json.inspectionId;
      const deadline=Date.now()+5*60_000;
      let consecutiveNetworkErrors=0;
      do{
        await new Promise(resolve=>setTimeout(resolve,1500));
        try{
          res=await fetch(apiBase+'/solver/inspect/poll',{
            signal:AbortSignal.timeout(30_000),
            method:'POST',headers:{'Content-Type':'application/json'},cache:'no-store',
            body:JSON.stringify({inspectionId})
          });
          json=await res.json();
          consecutiveNetworkErrors=0;
        }catch(error){
          consecutiveNetworkErrors++;
          if(consecutiveNetworkErrors>=12)throw error;
          continue;
        }
        if(res.status!==202&&(res.status<500||json.error))break;
      }while(Date.now()<deadline);
      if(res.status===202)throw new Error('The screenshot is taking longer than expected. Try reading it again.');
    }
    solverDebugAdd(hand,'inspect:http',{status:res.status,ok:res.ok,debug:json.debug||null,error:json.error||'',message:json.message||''});
    if(!res.ok)throw new Error(json.message||json.error||'Could not read the hand for solving.');
    if(!json.spot)throw new Error('The screenshot reader returned no hand details. Try again.');
    hand.solverSpot=json.spot;
    hand.solverSpotVersion=7;
    hand.solverResult=null;
    hand.solverJob=null;
    hand.solverStatus='';
    hand.solverError='';
    hand.reconstructionStatus='ready';
    save();
    if(!hand.solverAutoRun)notifyHandJobReady('reconstruction',hand);
  }catch(error){
    hand.solverError=String(error?.message||error);
    hand.reconstructionStatus='failed';
    solverDebugAdd(hand,'inspect:error',{message:String(error?.message||error),stack:String(error?.stack||'')});
    save();
    if(!backgroundId)notifyHandJobReady('reconstruction',hand,hand.solverError);
  }finally{
    solverInspectingHandIds.delete(id);
    if(route==='solverReview'&&solverReviewHandId===id)render();
  }
  if(hand.solverSpot&&hand.reconstructionStatus!=='failed')await continueHandSolve(hand);
}
function invalidateHandSolver(hand){
  cancelBackgroundHandJobs(hand);
  hand.solverAutoRun=false;
  hand.solverSpot=null;hand.solverSpotVersion=0;hand.solverResult=null;hand.solverJob=null;hand.solverStatus='';hand.solverError='';
}
function collectSolverSpot(){
  const hand=solverHand(); if(!hand?.solverSpot)return null;
  const spot=structuredClone(hand.solverSpot);
  if(!spot.observedHeroAction)spot.observedHeroAction='unknown';
  const numericKeys=['tableSize','effectiveStackBb','potAtDecisionBb','heroStackBb','villainStackBb','flopStartPotBb','flopStartEffectiveStackBb','observedHeroAmountBb','heroDisplayedStackBb','villainDisplayedStackBb','finalPotBb'];
  numericKeys.forEach(key=>{spot[key]=Number(spot[key])||0;});
  spot.streetStartPotsBb=spot.streetStartPotsBb||{};
  ['preflop','flop','turn','river'].forEach(street=>{spot.streetStartPotsBb[street]=Number(spot.streetStartPotsBb[street])||0;});
  document.querySelectorAll('[data-solver-field]').forEach(el=>{
    const key=el.dataset.solverField;
    let value=el.value;
    if(numericKeys.includes(key))value=Number(value)||0;
    if(key==='heroCards'||key==='board')value=value.trim().split(/\s+/).filter(Boolean);
    spot[key]=value;
  });
  const history=document.getElementById('solverActionHistory');
  if(history)spot.actionHistory=parseSolverActionLines(history.value);
  const complete=document.getElementById('solverHistoryComplete');
  if(complete)spot.actionHistoryComplete=complete.checked;
  spot.missingFields=solverMissing({...spot,missingFields:[]});
  if(JSON.stringify(hand.solverSpot)!==JSON.stringify(spot)){
    cancelBackgroundHandJobs(hand,['Solve']);hand.solverJob=null;hand.solverResult=null;hand.solverStatus='';
  }
  hand.solverSpot=spot; save();
  return spot;
}
function solverReview(){
  const h=solverHand();
  if(!h){route='handsLibrary';return handsLibrary();}
  const loading=solverInspectingHandIds.has(h.id)||h.reconstructionStatus==='pending'&&Boolean(h.backgroundReconstructionId);
  if(loading)return appShell(`${header('Solve <span class="accent">Hand</span>','We’ll take care of the setup.')}
    <section class="card pad solver-loading-card" role="status"><span class="solver-spinner"></span><strong>Reading your hand…</strong><p>We’re finding your decision and preparing the solve automatically.${supportsBackgroundHandJobs()?' You can leave the app; your progress is saved.':''}</p></section>${solverRangeSummary(h.solverSpot)}`,'sessions');
  if(!h.solverSpot)return appShell(`${header('Solve <span class="accent">Hand</span>','Your screenshot is saved.')}
    <section class="card pad solver-error-card"><strong>Couldn’t prepare this screenshot</strong><p>${esc(h.solverError||'Try reading the screenshot again.')}</p><button class="btn primary" data-reinspect-solver="${esc(h.id)}">Try again</button></section>`,'sessions');
  const s=h.solverSpot,missing=solverMissing(s),ready=missing.length===0;
  const actionText=solverActionLines(s.actionHistory||[]);
  const notes=(s.extractionNotes||[]).filter(Boolean);
  return appShell(`${header('Solve <span class="accent">Hand</span>','Your hand. We handle the setup.')}
    <section class="solver-readiness ${ready?'ready':'needs-review'}">
      <div class="solver-readiness-icon">${ready?'✓':'!'}</div>
      <div><strong>${ready?'Ready to solve':'Some hand details aren’t clear'}</strong>
      <small>${ready?'Both players’ ranges are prepared automatically.':'Try reading the screenshot again, or correct the hand below.'}</small></div>
    </section>
    ${missing.length?`<section class="card pad solver-missing-card"><strong>We need</strong>${solverVisibleIssues(s).map(x=>`<div>• ${esc(x)}</div>`).join('')}<button class="btn primary" data-reinspect-solver="${esc(h.id)}">Read screenshot again</button></section>`:''}
    <section class="card pad solver-hand-summary"><strong>${esc((s.heroCards||[]).join(' '))} · ${esc(s.heroPosition||'Hero')} vs ${esc(s.villainPosition||'Villain')}</strong><p>${esc(s.decisionStreet)}${s.board?.length?' · '+esc(s.board.join(' ')):''}</p></section>
    ${solverRangeSummary(s)}
    ${ready?`<button class="btn primary solver-run-btn" data-run-solver="${esc(h.id)}">Solve hand <span>›</span></button>`:''}
    <details class="card pad solver-review-card solver-optional-details"><summary>Edit hand details (optional)</summary>
      <div class="solver-grid">
        ${solverSelect('Game','game',s.game,[['NLH','NLH'],['unknown','Unknown']])}
        ${solverSelect('Format','format',s.format,[['cash','Cash'],['tournament','Tournament'],['unknown','Unknown']])}
        ${solverField('Table size','tableSize',s.tableSize||'', 'number','1')}
        ${solverSelect('Decision street','decisionStreet',s.decisionStreet,[['preflop','Preflop'],['flop','Flop'],['turn','Turn'],['river','River'],['unknown','Unknown']])}
        ${solverField('Hero position','heroPosition',s.heroPosition)}
        ${solverField('Villain position','villainPosition',s.villainPosition)}
        ${solverSelect('Hero role','heroRole',s.heroRole,[['OOP','Out of position'],['IP','In position'],['unknown','Unknown']])}
        ${solverField('Hero cards','heroCards',(s.heroCards||[]).join(' '))}
        ${solverField('Board','board',(s.board||[]).join(' '))}
        ${solverField('Pot now (BB)','potAtDecisionBb',s.potAtDecisionBb||'', 'number','0.1')}
        ${solverField('Effective stack now (BB)','effectiveStackBb',s.effectiveStackBb||'', 'number','0.1')}
        ${solverField('Pot entering flop (BB)','flopStartPotBb',s.flopStartPotBb||'', 'number','0.1')}
        ${solverField('Effective stack entering flop','flopStartEffectiveStackBb',s.flopStartEffectiveStackBb||'', 'number','0.1')}
      </div>
      <div class="solver-action-editor">
        <div class="row between"><div><small class="eyebrow">ACTION HISTORY</small><h3>Preflop → decision</h3></div></div>
        <p>One action per line: <code>street | position | action | amountBB | %pot</code></p>
        <textarea id="solverActionHistory" aria-label="Action history before Hero's decision" spellcheck="false">${esc(actionText)}</textarea>
        <label class="solver-complete-check"><input id="solverHistoryComplete" type="checkbox" ${s.actionHistoryComplete?'checked':''}><span><strong>Action history is complete</strong><small>No action is missing from preflop through this screenshot decision.</small></span></label>
      </div>
      ${notes.length?`<div class="solver-inspection-notes">${notes.map(n=>`<div>• ${esc(n)}</div>`).join('')}</div>`:''}
      <button class="btn secondary" data-save-solver-spot>Save corrections & continue</button>
    </details>
    <p class="field-hint">For post-hand review and training.</p>`,'sessions');
}
function solverFrequencyLabel(frequency){
  const percent=Math.max(0,Math.min(1,Number(frequency)||0))*100;
  return percent>0&&percent<.01?'<0.01%':`${Number(percent.toFixed(percent<1?2:1))}%`;
}
function solverStrategyAction(item){
  const action=String(item?.action||'').trim();
  return /^(bet|raise)$/i.test(action)&&Number(item.amount_bb)>0?`${action} ${Number(item.amount_bb)}`:action;
}
function solverMostFrequentAction(strategy=[]){
  return solverStrategyAction([...strategy].sort((a,b)=>(Number(b.frequency)||0)-(Number(a.frequency)||0))[0]);
}
function solverStrategyItem(strategy=[],action=''){
  const normalized=String(action).toLowerCase(),[kind,amount]=normalized.split(/\s+/);
  return strategy.find(item=>String(item.action||'').toLowerCase()===normalized||
    String(item.action||'').toLowerCase()===kind&&Number.isFinite(Number(amount))&&Math.abs(Number(item.amount_bb)-Number(amount))<.001);
}
function solverResultExplanation(solution,bestAction){
  const strategy=solution.strategy||[],frequentAction=solverMostFrequentAction(strategy);
  const frequent=solverStrategyItem(strategy,frequentAction),best=solverStrategyItem(strategy,bestAction);
  if(solution.evs?.actions?.length&&frequent&&best&&Number(best.frequency)+1e-9<Number(frequent.frequency)){
    return {
      summary:`The solver uses ${solverActionLabel(frequentAction)} most often (${solverFrequencyLabel(frequent.frequency)}). ${solverActionLabel(bestAction)} has the highest reported EV.`,
      details:"The strategy mix and EV ranking differ at this node. These are the provider's estimates; the highest-EV action is not necessarily the most frequent action.",
      facts:[]
    };
  }
  return solution.evReferenceVersion===1?solution.explanation:null;
}
function solverStrategyBars(strategy=[]){
  if(!strategy.length)return '<div class="empty">No mixed-strategy data returned.</div>';
  return strategy.map(x=>{
    const freq=Math.max(0,Math.min(1,Number(x.frequency)||0));
    const action=String(x.action||'Action');
    const amount=x.amount_bb? ` · ${Number(x.amount_bb).toFixed(1)} BB` : '';
    return `<div class="solver-strategy-row"><div class="row between"><span>${esc(action)}${esc(amount)}</span><strong>${esc(solverFrequencyLabel(freq))}</strong></div><div class="solver-bar"><i style="width:${freq*100}%"></i></div></div>`;
  }).join('');
}
function solverEvNumber(value){
  if(!['number','string'].includes(typeof value)||typeof value==='string'&&!value.trim())return null;
  return Number.isFinite(Number(value))?Number(value):null;
}
function solverEvDisplay(solution){
  const ev=solution.evs;
  if(!ev?.actions?.length)return null;
  const values=ev.actions.map((_,i)=>solverEvNumber(ev.values?.[i]));
  let decision=ev.reference==='decision';
  if(!decision){
    const fold=ev.actions.findIndex(action=>String(action).trim().toUpperCase()==='FOLD');
    const baseline=fold<0?null:values[fold];
    if(baseline!==null){values.forEach((value,i)=>{if(value!==null)values[i]=value-baseline;});decision=true;}
  }
  const available=values.filter(value=>value!==null);
  if(!available.length)return null;
  const best=Math.max(...available),index=values.indexOf(best);
  return {actions:ev.actions,values,best,bestAction:ev.actions[index],decision,losses:values.map(value=>value===null?null:Math.max(0,best-value))};
}
function solverResultMatchesSpot(solution,spot){
  if(!spot||spot.decisionStreet==='preflop')return true;
  if(solution.street!==spot.decisionStreet)return false;
  let facing=false;
  for(const action of (spot.actionHistory||[]).filter(action=>action.street===spot.decisionStreet)){
    if(['bet','donk_bet','raise','allin'].includes(action.action))facing=true;
    if(['call','fold'].includes(action.action))facing=false;
  }
  const legal=facing?['fold','call','raise','allin']:['check','bet','allin'];
  return (solution.strategy||[]).every(item=>legal.includes(String(item.action).toLowerCase().split(' ')[0]));
}
function solverActionLabel(action){
  const match=String(action).match(/^(BET|RAISE)\s+([\d.]+)$/i);
  return match?`${match[1].toUpperCase()} ${Number(match[2]).toFixed(1)} BB`:String(action).toUpperCase();
}
function solverResult(){
  const h=solverHand();
  if(!h){route='handsLibrary';return handsLibrary();}
  if(['starting','pending'].includes(h.solverStatus)){
    return appShell(`${header('GTO <span class="accent">Solution</span>','Your solve is running.')}
      <section class="card pad solver-running-card" role="status"><span class="solver-spinner"></span><strong>${h.solverSpot?'Solving your hand…':'Preparing & solving your hand…'}</strong><p>We read the hand, select GTO-based ranges for both players, and find your strategy.${supportsBackgroundHandJobs()?' You can leave the app; we’ll notify you when it’s ready.':' Your solve stays saved while you use the app.'}</p></section>
      ${solverRangeSummary(h.solverSpot)}`,'sessions');
  }
  const s=h.solverResult;
  if(!s){
    if(h.solverSpot&&solverMissing(h.solverSpot).length)return solverReview();
    return appShell(`${header('GTO <span class="accent">Solution</span>','')}
      <section class="card pad solver-error-card"><strong>Couldn’t finish this solve</strong><p>Your hand is saved. Try again in a moment.</p><button class="btn primary" data-solve-hand="${esc(h.id)}">Try again</button><details><summary>Error details</summary><p>${esc(h.solverError||'The solve could not be completed.')}</p></details></section>
      ${solverDebugPanel(h)}`,'sessions');
  }
  if(!solverResultMatchesSpot(s,h.solverSpot))return appShell(`${header('GTO <span class="accent">Solution</span>','')}
    <section class="card pad solver-error-card"><strong>This result needs a new solve</strong><p>The saved actions do not match the selected decision. Review the hand and solve again.</p><button class="btn primary" data-solve-hand="${esc(h.id)}">Review spot</button></section>`,'sessions');
  const ev=solverEvDisplay(s),bestEv=ev?.decision?ev.best:null;
  const bestAction=ev?.bestAction||solverMostFrequentAction(s.strategy||[])||s.bestAction||'—';
  const mix=solverStrategyItem(s.strategy||[],bestAction);
  const explanation=solverResultExplanation(s,bestAction);
  return appShell(`${header('GTO <span class="accent">Solution</span>','')}
    ${h.solverSpot?`<div class="solver-decision-context"><strong>${esc((h.solverSpot.heroCards||[]).join(' '))} · ${esc(h.solverSpot.decisionStreet)}</strong><span>${esc((h.solverSpot.board||[]).slice(0,({flop:3,turn:4,river:5})[h.solverSpot.decisionStreet]||0).join(' '))}</span></div>`:''}
    <section class="card pad solver-answer-card">
      <div><small>${ev?'Highest reported EV':'Most frequent action'}</small><strong>${esc(solverActionLabel(bestAction))}</strong></div>
      <div><small>GTO mix</small><strong class="positive">${mix?esc(solverFrequencyLabel(mix.frequency)):'—'}</strong></div>
      ${bestEv!==null?`<div class="solver-best-ev"><small>EV from this decision</small><strong>${bestEv.toFixed(3)} BB</strong></div>`:''}
    </section>
    <section class="card pad solver-strategy-card"><div class="section-title">GTO strategy</div>${solverStrategyBars(s.strategy||[])}</section>
    ${ev?`<section class="card pad solver-ev-card"><div class="section-title">${ev.decision?'Action EVs':'EV loss vs best action'}</div><p class="field-hint">${ev.decision?'Measured from this decision. Folding is 0 BB; earlier wagers are sunk costs.':'The solver’s absolute EV reference is unavailable. These differences show the cost of each action; 0 means best.'}</p>${ev.actions.map((action,i)=>`<div class="row between solver-ev-row"><span>${esc(solverActionLabel(action))}</span><strong>${ev.values[i]===null?'Unavailable':(ev.decision?ev.values[i]:ev.losses[i]).toFixed(3)+' BB'}</strong></div>`).join('')}</section>`:''}
    <section class="card pad solver-why-card"><div class="section-title title-with-icon">${uiIcon('light')} Why this action</div><strong>${esc(explanation?.summary||'Compare the strategy mix and EV differences above.')}</strong>${explanation?.details?`<p>${esc(explanation.details)}</p>`:''}${(explanation?.facts||[]).length?`<div class="solver-facts">${explanation.facts.map(x=>`<span>${esc(x)}</span>`).join('')}</div>`:''}</section>
    ${solverRangeSummary(h.solverSpot)}
    <details class="card pad solver-assumptions"><summary>Solve assumptions</summary>${(s.assumptions||[]).map(x=>`<div>• ${esc(x)}</div>`).join('')}</details>
    <div class="solver-study-note"><strong>Post-hand study only</strong><span>Solver results are for review and training, not live assistance.</span></div>
    <button class="btn secondary" data-reinspect-solver="${esc(h.id)}">Read & solve again</button>
    ${solverDebugPanel(h)}`,'sessions');
}
async function runSolverForHand(id,options={}){
  const h=findHandRecord(id);if(!h)return;
  if(['starting','pending'].includes(h.solverStatus))return;
  if(!options.background)solverReviewHandId=id;
  const spot=options.fromEditor?collectSolverSpot()||h.solverSpot:h.solverSpot;
  const missing=solverMissing(spot);
  if(missing.length){h.solverError='Complete the highlighted hand details first.';save();render();return;}
  h.solverResult=null;h.solverJob=null;h.solverError='';h.solverStatus='starting';solverDebugAdd(h,'solve:start',{spot});save();if(!options.background)route='solverResult';render();
  try{
    if(supportsBackgroundHandJobs()){
      h.backgroundSolveId=handJobRequestId();h.solverStatus='pending';save();render();
      await enqueueBackgroundHandJob({requestId:h.backgroundSolveId,kind:'solve',handId:id,payload:{spot}});
      return;
    }
    let res=null,json={},lastError=null;
    for(let attempt=0;attempt<4;attempt++){
      try{
        res=await fetch(HAND_ANALYSIS_API_URL.replace(/\/$/,'')+'/solver/solve',{
          method:'POST',headers:{'Content-Type':'application/json'},cache:'no-store',body:JSON.stringify({spot})
        });
        json=await res.json().catch(()=>({}));
        solverDebugAdd(h,'solve:http',{attempt:attempt+1,status:res.status,ok:res.ok,debug:json.debug||null,error:json.error||'',message:json.message||''});
        if(res.ok||res.status===202)break;
        if(res.status<500)break;
        lastError=new Error(json.message||json.error||('HTTP '+res.status));
      }catch(error){
        lastError=error;
        solverDebugAdd(h,'solve:fetch_error',{attempt:attempt+1,message:String(error?.message||error),stack:String(error?.stack||'')});
      }
      if(attempt<3)await new Promise(resolve=>setTimeout(resolve,700*(attempt+1)));
    }
    if(!res)throw lastError||new Error('Network unavailable. Your hand is still saved.');
    if(res.status===202&&json.job){
      h.solverJob=json.job;h.solverStatus='pending';solverDebugAdd(h,'solve:scheduled',{debug:json.debug||null,job:{provider:json.job.provider,decisionStreet:json.job.decisionStreet,expectedSegments:json.job.expectedSegments,debugRequestId:json.job.debugRequestId}});save();render();pollSolverJob(id);return;
    }
    if(!res.ok){
      if(res.status===422&&json.error==='invalid_spot'){
        h.solverStatus='';h.solverJob=null;h.solverSpotVersion=0;h.solverError='Re-reading this screenshot because the saved solver data is stale or invalid.';save();render();
        await inspectHandForSolver(id,true);
        return;
      }
      if(res.status===422&&Array.isArray(json.missingFields??json.missing)){
        h.solverStatus='';h.solverJob=null;h.solverSpot.missingFields=json.missingFields||json.missing;h.solverError=json.message||'Review the detected hand details.';save();route='solverReview';render();return;
      }
      throw new Error(json.message||json.error||lastError?.message||'Solver request failed.');
    }
    h.solverResult=json.solution;h.solverJob=null;h.solverStatus='solved';save();render();
    notifyHandJobReady('solve',h);
  }catch(error){
    h.solverStatus='failed';h.solverError=String(error?.message||error);solverDebugAdd(h,'solve:error',{message:String(error?.message||error),stack:String(error?.stack||'')});save();render();
  }
}
async function pollSolverJob(id){
  if(solverPolling.has(id))return;
  const h=findHandRecord(id);if(!h?.solverJob)return;
  solverPolling.add(id);
  let consecutiveNetworkErrors=0;
  try{
    for(let attempt=0;attempt<100;attempt++){
      const current=findHandRecord(id);if(!current?.solverJob)break;
      const pollingJob=current.solverJob;
      let res,json;
      try{
        res=await fetch(HAND_ANALYSIS_API_URL.replace(/\/$/,'')+'/solver/poll',{
          method:'POST',headers:{'Content-Type':'application/json'},cache:'no-store',signal:AbortSignal.timeout(30000),body:JSON.stringify({job:pollingJob})
        });
        json=await res.json().catch(()=>({}));
        if(findHandRecord(id)?.solverJob!==pollingJob)return;
        consecutiveNetworkErrors=0;
        solverDebugAdd(current,'poll:http',{attempt:attempt+1,status:res.status,ok:res.ok,spotStatus:json.spotStatus||'',debug:json.debug||null,error:json.error||'',message:json.message||''});
      }catch(error){
        consecutiveNetworkErrors++;
        solverDebugAdd(current,'poll:fetch_error',{attempt:attempt+1,consecutiveNetworkErrors,message:String(error?.message||error),stack:String(error?.stack||'')});
        current.solverStatus='pending';
        current.solverError='';
        save();
        if(route==='solverResult'&&solverReviewHandId===id)render();
        if(consecutiveNetworkErrors>=12)return;
        await new Promise(resolve=>setTimeout(resolve,Math.min(8000,1500*consecutiveNetworkErrors)));
        continue;
      }
      if(res.status===202){ await new Promise(resolve=>setTimeout(resolve,2200)); continue; }
      if(res.status>=500){
        await new Promise(resolve=>setTimeout(resolve,2500));
        continue;
      }
      if(!res.ok){
        if(res.status===422&&json.error==='action_path_not_in_tree'){
          current.solverJob=null;current.solverStatus='failed';
          current.solverError=json.message||'The solver tree did not contain the observed action line. Review the details or try solving again.';
          solverDebugAdd(current,'poll:reinspect',{reason:json.error,expectedPath:json.expectedPath||[],availableHeroNodes:json.availableHeroNodes||[],debug:json.debug||null});
          save();
          if(route==='solverResult'&&solverReviewHandId===id)render();
          return;
        }
        throw new Error(json.message||json.error||'Solver failed.');
      }
      current.solverResult=json.solution;current.solverJob=null;current.solverStatus='solved';current.solverError='';solverDebugAdd(current,'poll:complete',{debug:json.debug||null});save();
      if(route==='solverResult'&&solverReviewHandId===id)render();
      captureToast('GTO solution ready ✓');
      notifyHandJobReady('solve',current);
      return;
    }
  }catch(error){
    const current=findHandRecord(id);
    if(current){current.solverStatus='failed';current.solverError=String(error?.message||error);solverDebugAdd(current,'poll:error',{message:String(error?.message||error),stack:String(error?.stack||'')});save();}
    if(route==='solverResult'&&solverReviewHandId===id)render();
  }finally{solverPolling.delete(id);}
}
function resumePendingSolverJobs(){
  allHandsLibrary().forEach(h=>{if(h.solverStatus==='pending'&&h.solverJob)pollSolverJob(h.id);});
}

function handsSwitcher(active){
  return '<div class="library-switch"><button class="'+(active==='sessions'?'active':'')+'" data-nav="sessions">Sessions</button><button class="'+(active==='hands'?'active':'')+'" data-nav="handsLibrary">Hands</button></div>';
}
function handLibraryTime(h){
  const d=new Date(h.capturedAt||Date.now());
  return d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
}
function handLibraryGroup(h){
  const d=new Date(h.capturedAt||Date.now()), now=new Date();
  const today=d.toDateString()===now.toDateString();
  if(today)return 'Today';
  const yesterday=new Date(now);yesterday.setDate(now.getDate()-1);
  if(d.toDateString()===yesterday.toDateString())return 'Yesterday';
  return d.toLocaleDateString([], {month:'long',day:'numeric'});
}
function handsLibrary(){
  const all=allHandsLibrary().filter(h=>!h.autoCandidate);
  const query=handsSearch.trim().toLocaleLowerCase();
  const rows=all.filter(h=>handsFilter==='all'||(handsFilter==='session'&&h._scope==='session')||(handsFilter==='general'&&h._scope==='general')).filter(h=>!query||[handDisplayTitle(h),h.description,h.notes,h.site,h.stakes,h.tournamentName,...(h.heroCards||[]),...(h.board||[])].filter(Boolean).join(' ').toLocaleLowerCase().includes(query));
  const groups=[];
  rows.forEach(h=>{const label=handLibraryGroup(h);let g=groups.find(x=>x.label===label);if(!g){g={label,rows:[]};groups.push(g);}g.rows.push(h);});
  return appShell(`${header('Hand library','Save the spot. Study the decision.',false)}
    ${handsSwitcher('hands')}
    <section class="hands-a-toolbar">
      <label class="library-search">${uiIcon('search')}<input id="handsSearch" type="search" placeholder="Search hands, cards, or notes" aria-label="Search saved hands" value="${esc(handsSearch)}"></label>
      <div class="hand-filter-pills a-segmented">${[['all','All Hands'],['session','Session'],['general','Unassigned']].map(([v,l])=>`<button class="${handsFilter===v?'active':''}" data-hands-filter="${v}">${l}</button>`).join('')}</div>
    </section>
    <section class="hand-drop-zone compact" id="handDropZone">${uiIcon('upload')}<div class="upload-copy"><strong>Bring a hand to the table</strong><span>Choose a screenshot, drop it here, or share it to Inner Game.</span></div><button class="btn secondary tiny" data-upload-hand>Add screenshot</button><input type="file" id="handUpload" accept="image/png,image/jpeg,image/webp" class="sr-only" aria-label="Choose hand screenshot"></section>
    <div class="hands-a-groups">${groups.length?groups.map(g=>`<section class="hands-a-group"><div class="hands-a-group-title"><strong>${esc(g.label)}</strong><span>${g.rows.length} hand${g.rows.length===1?'':'s'}</span></div><div class="captured-hands-list">${g.rows.map(h=>handCard(h,true,true)).join('')}</div></section>`).join(''):`<div class="empty-state card">${uiIcon('cards')}<strong>${all.length?'No matching hands':'Your study starts here'}</strong><p>${all.length?'Try another search or filter.':'Add a screenshot to reconstruct the hand and explore the solver’s strategy.'}</p></div>`}</div>`,'sessions');
}
function importHandScreenshot(file){
  if(!file)return;
  if(!['image/png','image/jpeg','image/webp'].includes(file.type)){captureToast('Choose a PNG, JPEG, or WebP screenshot.','error');return;}
  if(file.size>10*1024*1024){captureToast('Choose a screenshot smaller than 10 MB.','error');return;}
  captureToast('Screenshot selected · processing…');
  const reader=new FileReader();
  reader.onerror=()=>captureToast('Could not read this screenshot. Try choosing it again.','error');
  reader.onload=()=>window.innerGameReceiveScreenshot(reader.result,'manual_upload');
  reader.readAsDataURL(file);
}
function sessionHands(){
  const target=selectedSessionHandsId==='active'?state.activeSession:state.sessions.find(s=>s.id===selectedSessionHandsId);
  if(!target){route='sessions';return sessions();}
  const all=allSessionHands(target);
  const processing=all.filter(h=>h.autoCandidate||['analyzing','pending'].includes(h.status));
  const hands=all.filter(h=>!h.autoCandidate&&!['analyzing','pending'].includes(h.status));
  const noted=hands.filter(h=>(h.notes||'').trim()).length;
  const subtitle=selectedSessionHandsId==='active'
    ? [target.stakes,target.room].filter(Boolean).join(' · ')||'Current session'
    : [target.date,target.game,target.room].filter(Boolean).join(' · ');
  return appShell(`${header('Session <span class="accent">Hands</span>',subtitle)}
    <section class="hands-summary session-hands-summary">
      <div><strong>${hands.length}</strong><span>Saved</span></div>
      <div><strong>${noted}</strong><span>With notes</span></div>
      <div class="${processing.length?'processing':''}"><strong>${processing.length}</strong><span>Processing</span></div>
    </section>
    ${processing.length?`<div class="session-processing-row"><span class="processing-dot"></span><div><strong>Processing ${processing.length} screenshot${processing.length===1?'':'s'}</strong><small>They’ll appear here automatically.</small></div></div>`:''}
    <div class="session-hands-section-head"><strong>${hands.length?'Saved hands':'Hands'}</strong><span>${hands.length?'Newest first':''}</span></div>
    <div class="captured-hands-list session-hands-list">${hands.length?hands.slice().sort((a,b)=>(b.capturedAt||0)-(a.capturedAt||0)).map(h=>handCard(h,false,false)).join(''):'<div class="notice"><strong>No saved hands yet.</strong><br>Take a poker screenshot during the session and it will be added automatically.</div>'}</div>`,'sessions');
}
function handCard(h,showScope=false,libraryMode=false){
  const statusInfo=handStatusInfo(h);
  const title=normalizeCapturedTitle(h,handDisplayTitle(h));
  const scope=showScope?h._sessionLabel:'';
  const note=(h.notes||'').trim();
  const attr=`data-open-hand="${esc(h.id)}"`;
  return `<article class="card captured-hand-card option-a ${esc(statusInfo.status)}" ${attr} role="button" tabindex="0" aria-label="Open ${esc(title)}">
    <img data-hand-image-key="${esc(h.imageKey)}" alt="">
    <div class="captured-hand-copy">
      <div class="hand-card-top"><strong>${esc(title)}</strong><time>${esc(handLibraryTime(h))}</time></div>
      <small>${esc([scope,h.site,h.blinds||h.stakes].filter(Boolean).join(' · ')||'Poker hand')}</small>
      ${note?`<p class="hand-note-preview">${esc(note)}</p>`:''}
      <div class="hand-a-bottom"><span class="hand-status ${esc(statusInfo.status)}">${esc(statusInfo.label)}</span><span class="hand-open-affordance">View hand <b>›</b></span></div>
    </div>
  </article>`;
}
async function hydrateHandImages(){for(const el of document.querySelectorAll('[data-hand-image-key]')){try{const src=await getHandImage(el.dataset.handImageKey);if(src)el.src=src;}catch{}}}
async function retryCapturedHand(id){
  const hand=findHandRecord(id);if(!hand)return;
  try{
    const src=await getHandImage(hand.imageKey);
    if(!src){captureToast('Screenshot image is missing.','error');return;}
    await analyzeStoredHand(id,src);
  }catch(e){captureToast('Could not retry analysis.','error');}
}
function triggerNativeCapture(){nativeCall('captureHand',{});}

function syncAutoScreenshotWatcher(){
  if(state.activeSession&&!state.activeSession.id)state.activeSession.id=crypto.randomUUID?.()||String(Date.now());
  const sessionId=state.activeSession?.id||'';
  if(sessionId===syncedScreenshotSessionId)return;
  syncedScreenshotSessionId=sessionId;
  nativeCall('setAutoScreenshotEnabled',{enabled:Boolean(sessionId),sessionId,startedAt:state.activeSession?.startedAt||0});
}
function scheduleBreakReminders(){ if(!state.activeSession)return; nativeCall('scheduleBreakReminders',{startedAt:state.activeSession.startedAt, intervalMinutes:60, breakMinutes:5}); }
function cancelBreakReminders(){ nativeCall('cancelBreakReminders'); }

function homeMoneyCard(){
  const rows=filterMoneySessions(), cumulative=[0]; let total=0;
  rows.forEach(s=>{total+=Number(s.pnl)||0;cumulative.push(total);});
  const values=cumulative.length>1?cumulative:[0,0], min=Math.min(...values,0), max=Math.max(...values,0), span=Math.max(1,max-min);
  const W=360,H=150,P=12;
  const pts=values.map((v,i)=>{const x=P+(i/(values.length-1||1))*(W-P*2);const y=P+((max-v)/span)*(H-P*2);return [x,y];});
  const path=pts.map((p,i)=>(i?'L':'M')+p[0].toFixed(1)+','+p[1].toFixed(1)).join(' ');
  const area=path+' L '+pts.at(-1)[0]+','+(H-P)+' L '+pts[0][0]+','+(H-P)+' Z';
  const dots=rows.map((s,i)=>{const p=pts[i+1];return '<circle class="home-money-dot" cx="'+p[0]+'" cy="'+p[1]+'" r="4"/><circle class="home-money-hit" data-money-point="'+i+'" cx="'+p[0]+'" cy="'+p[1]+'" r="16"/>';}).join('');
  const ranges=[['7','1W'],['30','1M'],['90','3M'],['365','1Y'],['all','All']];
  const weekAgo=Date.now()-7*86400000;
  const weekRows=state.sessions.filter(s=>{const t=s.startAt||parseLocalDateTime((s.date||localDateValue())+'T00:00');return t&&t>=weekAgo;});
  const weekPnl=weekRows.reduce((a,s)=>a+(Number(s.pnl)||0),0);
  const weekMs=weekRows.reduce((a,s)=>a+(Number(s.durationMs)||0),0);
  return '<section class="apple-panel home-money-card">'+
    '<div class="home-money-head"><div><span>Net P/L</span><strong class="'+(total>=0?'positive':'negative')+'">'+money(total)+'</strong></div><span class="period-pill">'+(moneyRange==='7'?'1W':moneyRange==='30'?'1M':moneyRange==='90'?'3M':moneyRange==='365'?'1Y':'All')+'</span></div>'+
    '<div class="home-money-chart">'+
      (rows.length?'<div id="moneyTooltip" class="money-tooltip hidden"></div><svg viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none"><defs><linearGradient id="homeMoneyFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#35d98a" stop-opacity=".26"/><stop offset="100%" stop-color="#35d98a" stop-opacity="0"/></linearGradient></defs><path class="home-money-area" d="'+area+'"/><path class="home-money-line" d="'+path+'"/>'+dots+'</svg>':'<div class="empty graph-empty">Log a session to start your graph.</div>')+
    '</div>'+
    '<div class="home-money-ranges">'+ranges.map(([v,l])=>'<button class="'+(moneyRange===v?'active':'')+'" data-money-range="'+v+'">'+l+'</button>').join('')+'</div>'+
    '<div class="home-money-kpis"><div><strong>'+weekRows.length+'</strong><span>Sessions</span></div><div><strong>'+Math.round(weekMs/3600000)+'h</strong><span>Play time</span></div><div><strong class="'+(weekPnl>=0?'positive':'negative')+'">'+money(weekPnl)+'</strong><span>This week</span></div></div>'+
  '</section>';
}

function home(){
  const g=gamificationStats(),recent=[...state.sessions].reverse().slice(0,3);
  const greeting=(new Date().getHours()<12?'Good morning':new Date().getHours()<18?'Good afternoon':'Good evening');
  const actionPrimary=state.activeSession
    ? `<button class="home-action primary" data-nav="active">${uiIcon('play')}<span><strong>Resume Session</strong><small>Your session is running</small></span>${uiIcon('arrow')}</button>`
    : `<button class="home-action primary" data-start-prep>${uiIcon('play')}<span><strong>Start Session</strong><small>Prepare. Focus. Play.</small></span>${uiIcon('arrow')}</button>`;
  const dots=[0,1,2,3,4,5,6].map((_,i)=>'<span class="'+(i<Math.min(g.aStreak,7)?'done':'')+'"></span>').join('');
  return appShell(`<div class="home-top"><small>${greeting}${state.profile?.name?', '+esc(state.profile.name):''}</small><h1>Your game, <span class="accent">in focus.</span></h1><p>A little intention. A better session.</p></div>
    <section class="home-focus-card card"><div class="focus-orbit" aria-hidden="true"><i></i><i></i><i></i><b></b></div><div class="focus-card-copy"><span class="eyebrow">${state.activeSession?'SESSION LIVE':'BUILD YOUR A-GAME'}</span><h2>${state.activeSession?'Stay in your rhythm.':'Clear mind.<br>Sharper decisions.'}</h2><p>${state.activeSession?'Your goals and saved hands are one tap away.':'Make your next session a deliberate one.'}</p></div><div class="home-actions">${actionPrimary}<button class="home-action secondary" data-nav="log">${uiIcon('edit')}<span><strong>Log Session</strong><small>Reflect on your play</small></span></button></div></section>
    <div class="dashboard-two">${homeMoneyCard()}<div class="dashboard-aside">
      <section class="card pad daily-tool-card"><div class="section-heading"><span class="eyebrow">BETWEEN SESSIONS</span><span class="mini-badge">Your toolkit</span></div><button class="tool-link" data-nav="handsLibrary"><span class="tool-icon">${uiIcon('cards')}</span><span><strong>Study your hands</strong><small>${allHandsLibrary().filter(h=>!h.autoCandidate).length} saved · review, reconstruct & solve</small></span>${uiIcon('arrow')}</button><button class="tool-link" data-nav="breathe"><span class="tool-icon lavender">${uiIcon('breathe')}</span><span><strong>Find your focus</strong><small>A guided reset before you play</small></span>${uiIcon('arrow')}</button></section>
      <button class="apple-panel streak-panel compact" data-nav="profile"><div class="streak-main"><span class="streak-icon">${uiIcon('award')}</span><div><strong>${g.aStreak}-session A-game streak</strong><small>Good process is worth repeating.</small><div class="streak-dots">${dots}</div></div>${uiIcon('arrow')}</div></button>
      <section class="card pad progress-snapshot"><div class="row between"><div><span class="eyebrow">YOUR PROGRESS</span><strong>Level ${g.level}</strong></div><span class="xp-badge">${g.xp} XP</span></div><div class="xp-track"><i style="width:${g.progress*100}%"></i></div><p>Every reviewed session moves you forward.</p></section>
    </div></div>
    <div class="section-heading"><h2 class="section-title">Recent sessions</h2><button class="text-link" data-nav="sessions">View all ${uiIcon('arrow')}</button></div><section class="session-list session-list-cards">${recent.length?recent.map(sessionRow).join(''):`<div class="card empty-state">${uiIcon('sessions')}<h3>Your story starts with one session.</h3><p>Log your play and see your process improve over time.</p><button class="btn secondary" data-nav="log">Log your first session</button></div>`}</section>`,'home');
}
function bestStateLabel(){ if(!state.sessions.length)return '—'; const buckets={Calm:[],Focused:[],Tense:[],Tilted:[]}; state.sessions.forEach(s=>{(buckets[s.state]??=[]).push(s.process||0)}); return Object.entries(buckets).sort((a,b)=>avg(b[1])-avg(a[1]))[0]?.[0]||'—'; }

function prepOverview(){ return appShell(`${header('Session <span class="accent">Preparation</span>','Get into the right state before you play.')}
  <div class="stack">
    ${stepper(0)}
    <div class="prep-list">
      ${prepRow('◌','Breathe',`${currentBreathWorkout().name} · ${levelMinutes(breathLevel)} min`,'breathe')}
      ${prepRow('◎','Set Goals','Choose 2–3 process goals','goals')}
      ${prepRow('♠','Play 3 Hands','3 random hold’em spots + your reasoning','handsIntro','New')}
      ${prepRow('◉','Readiness Check','Energy, focus, mental noise','goals')}
      ${prepRow('▣','Game Plan','Stakes, buy-in, stop-loss','review')}
    </div>
    <div class="notice"><strong>Keep it simple.</strong><br>You’re preparing your process, not predicting results.</div>
    <button class="btn primary" data-nav="breathe">Begin Prep <span>→</span></button>
  </div>`,'home'); }
function prepRow(icon,title,sub,to,badge=''){ return `<button class="prep-item ${badge?'featured':''}" data-nav="${to}"><span class="icon">${symbolIcon(icon)}</span><span class="prep-copy"><strong>${title}${badge?` <span class="mini-badge">${badge}</span>`:''}</strong><small>${sub}</small></span><span class="chev">${uiIcon('arrow')}</span></button>`; }
function levelMinutes(l){ return ({beginner:3,intermediate:10,advanced:20})[l]||3; }
function fmtTime(sec){ const total=Math.max(0,Math.ceil(Number(sec)||0)),m=Math.floor(total/60),s=total%60; return `${m}:${String(s).padStart(2,'0')}`; }
function currentBreathWorkout(){ return BREATH_WORKOUTS[breathWorkout] || BREATH_WORKOUTS.focus; }
function breathPhaseAt(elapsedSeconds){
  const phases=currentBreathWorkout().phases;
  const cycleTotal=phases.reduce((a,p)=>a+p.duration,0);
  let within=((elapsedSeconds%cycleTotal)+cycleTotal)%cycleTotal;
  for(let i=0;i<phases.length;i++){
    const phase=phases[i];
    if(within<phase.duration) return {index:i,phase,remaining:phase.duration-within,progress:within/phase.duration};
    within-=phase.duration;
  }
  return {index:0,phase:phases[0],remaining:phases[0].duration,progress:0};
}
function breathFill(status){
  const mode=status.phase.fill;
  if(mode==='up') return .08 + (.92*status.progress);
  if(mode==='down') return 1 - (.92*status.progress);
  if(mode==='full') return 1;
  return .08;
}
function breathLegend(){
  return currentBreathWorkout().phases.map(p=>`<div><span class="legend-dot ${p.cls}-dot"></span><b>${esc(p.name)}</b><small>${p.duration}s</small></div>`).join('');
}
function breathe(){
  breathLevel=state.prep.breathLevel||breathLevel;
  breathWorkout=state.prep.breathWorkout||breathWorkout;
  const maxSeconds=levelMinutes(breathLevel)*60;
  if(!breathRunning) breathRemaining=Math.min(breathRemaining||maxSeconds,maxSeconds);
  const total=maxSeconds;
  const elapsed=Math.max(0,total-breathRemaining);
  const status=breathPhaseAt(elapsed);
  const overall=Math.max(0,Math.min(1,elapsed/total));
  const fill=breathFill(status);
  const w=currentBreathWorkout();
  return appShell(`${header('<span class="accent">Breathe</span>','Choose the state you want, then follow the circle.')}
  ${stepper(0)}
  <div class="breath-workouts">
    ${Object.entries(BREATH_WORKOUTS).map(([key,item])=>`<button class="breath-workout ${breathWorkout===key?'selected':''}" data-breath-workout="${key}"><strong>${item.name}</strong><small>${item.short}</small></button>`).join('')}
  </div>
  <div class="workout-description"><strong>${w.name}</strong><span>${w.description}</span></div>
  <div class="levels">
    ${[['beginner','Beginner','3 min'],['intermediate','Intermediate','10 min'],['advanced','Advanced','20 min']].map(([v,l,m])=>`<button class="level ${breathLevel===v?'selected':''}" data-breath-level="${v}">${l}<small>${m}</small></button>`).join('')}
  </div>
  <section class="breath-stage card pad">
    <div class="breath-topline"><span id="breathTotalLabel">${fmtTime(breathRemaining)} remaining</span><button class="sound-toggle ${breathSoundEnabled?'on':''}" id="breathSound" type="button" aria-label="Toggle breathing sounds">${breathSoundEnabled?'♪ Sound on':'Sound off'}</button></div>
    <div class="breath-orb-wrap" style="--overall:${overall};--phase:${status.progress};--fill:${fill}">
      <div class="breath-progress-ring"></div>
      <div class="breath-orb ${status.phase.cls}" id="breathOrb">
        <div class="breath-fill" id="breathFill"></div>
        <div class="breath-inner">
          <div class="breath-phase-name" id="breathPhase">${breathRunning?status.phase.name:'Ready'}</div>
          <div class="breath-phase-count" id="breathPhaseCount">${breathRunning?Math.ceil(status.remaining):''}</div>
          <div class="breath-phase-cue" id="breathCue">${breathRunning?status.phase.cue:'Tap Start when you are ready'}</div>
        </div>
      </div>
    </div>
    <div class="breath-legend" aria-label="Breathing pattern">${breathLegend()}</div>
    <div class="center-actions"><button class="btn ${breathRunning?'secondary':'primary'} compact" id="breathToggle">${breathRunning?'Pause':'Start'}</button><button class="btn secondary compact" id="breathReset">Reset</button></div>
  </section>
  <div class="notice"><strong>Follow the fill.</strong><br>The whole circle fills on the inhale, stays full on a hold, and empties on the exhale. If you feel lightheaded or uncomfortable, stop and breathe normally.</div>
  <div class="stack"><button class="btn primary" data-complete-breath>Complete Step <span>→</span></button><button class="btn ghost" data-nav="goals">Skip for now</button></div>`,'home');
}
function ensureBreathAudio(){
  if(breathAudio) return breathAudio;
  try{ breathAudio=new (window.AudioContext||window.webkitAudioContext)(); }catch{}
  return breathAudio;
}
function playBreathCue(phaseIndex){
  if(!breathSoundEnabled)return;
  const ctx=ensureBreathAudio(); if(!ctx)return;
  try{
    if(ctx.state==='suspended')ctx.resume();
    const status=currentBreathWorkout().phases[phaseIndex]||currentBreathWorkout().phases[0];
    const now=ctx.currentTime, osc=ctx.createOscillator(), gain=ctx.createGain();
    osc.type='sine';
    const isIn=status.cls==='inhale', isOut=status.cls==='exhale';
    const f1=isIn?205:isOut?390:280, f2=isIn?360:isOut?175:280;
    osc.frequency.setValueAtTime(f1,now); osc.frequency.exponentialRampToValueAtTime(Math.max(80,f2),now+.62);
    gain.gain.setValueAtTime(.0001,now); gain.gain.exponentialRampToValueAtTime(.038,now+.06); gain.gain.exponentialRampToValueAtTime(.0001,now+.72);
    osc.connect(gain).connect(ctx.destination); osc.start(now); osc.stop(now+.75);
  }catch{}
}
function updateBreathVisual(){
  const total=levelMinutes(breathLevel)*60;
  if(breathRunning){ breathRemaining=Math.max(0,(breathEndAt-Date.now())/1000); }
  const elapsed=Math.max(0,total-breathRemaining), status=breathPhaseAt(elapsed), fill=breathFill(status);
  if(breathRunning && status.index!==breathLastPhase){ breathLastPhase=status.index; playBreathCue(status.index); }
  const t=document.getElementById('breathTotalLabel'); if(t)t.textContent=`${fmtTime(Math.ceil(breathRemaining))} remaining`;
  const phase=document.getElementById('breathPhase'); if(phase)phase.textContent=breathRunning?status.phase.name:'Ready';
  const count=document.getElementById('breathPhaseCount'); if(count)count.textContent=breathRunning?Math.max(1,Math.ceil(status.remaining)):'';
  const cue=document.getElementById('breathCue'); if(cue)cue.textContent=breathRunning?status.phase.cue:'Tap Start when you are ready';
  const orb=document.getElementById('breathOrb'); if(orb){orb.className=`breath-orb ${breathRunning?status.phase.cls:''}`;}
  const wrap=document.querySelector('.breath-orb-wrap'); if(wrap){wrap.style.setProperty('--overall',Math.max(0,Math.min(1,elapsed/total)));wrap.style.setProperty('--phase',status.progress);wrap.style.setProperty('--fill',fill);}
  if(breathRunning && breathRemaining<=0){ stopBreath(); state.prep.breathLevel=breathLevel; state.prep.breathWorkout=breathWorkout; save(); navigate('goals'); }
}
function startBreath(){
  if(breathRunning)return;
  if(breathSoundEnabled)ensureBreathAudio();
  breathRunning=true; breathEndAt=Date.now()+breathRemaining*1000; breathLastPhase=-1; render();
  updateBreathVisual(); breathTimer=setInterval(updateBreathVisual,100);
}
function stopBreath(){
  if(breathRunning && breathEndAt) breathRemaining=Math.max(0,(breathEndAt-Date.now())/1000);
  if(breathTimer)clearInterval(breathTimer); breathTimer=null; breathRunning=false; breathEndAt=0; breathLastPhase=-1;
}
function resetBreath(){ stopBreath(); breathRemaining=levelMinutes(breathLevel)*60; render(); }

function goals(){ const p=state.prep; while(p.goals.length<3)p.goals.push(''); return appShell(`${header('Goals & <span class="accent">Readiness</span>','Write the process you want to follow today.')}
  ${stepper(1)}
  <section class="card pad"><div class="row between section-head"><div><div class="section-title">Your process goals</div><div class="session-meta">Free text — make each goal specific and controllable.</div></div><span class="goal-count">3 max</span></div>
  <div class="free-goals">${[0,1,2].map(i=>`<div class="goal-input-row"><span>${i+1}</span><input type="text" maxlength="120" data-goal-input="${i}" value="${esc(p.goals[i]||'')}" placeholder="${i===0?'e.g. Pause before big river decisions':i===1?'e.g. No cashier checking during play':'e.g. Take a full reset after a big pot'}"></div>`).join('')}</div></section>
  <section class="card pad"><div class="section-title">Readiness Check</div>${rangeRow('Energy','energy',p.energy)}${rangeRow('Focus','focus',p.focus)}${rangeRow('Mental Noise','noise',p.noise)}</section>
  <section class="card pad"><div class="section-title">Environment</div><div class="goal-grid">${envChip('silent','Phone on silent',p.environment.silent)}${envChip('distractions','No distractions',p.environment.distractions)}${envChip('water','Water ready',p.environment.water)}</div></section>
  <button class="btn primary" data-nav="handsIntro">Continue <span>→</span></button>`,'home'); }
function rangeRow(label,key,val){ return `<div class="range-row"><div class="range-label"><span class="label">${label}</span><strong id="v-${key}">${val}</strong></div><input type="range" min="1" max="10" value="${val}" data-range="${key}"><div class="range-scale"><span>Low</span><span>High</span></div></div>`; }
function envChip(key,label,val){ return `<button class="goal-chip ${val?'selected':''}" data-env="${key}">${val?'✓ ':''}${label}</button>`; }


function randomThreeHandIds(){
  const ids=HAND_BANK.map(h=>h.id);
  for(let i=ids.length-1;i>0;i--){
    let j;
    if(globalThis.crypto?.getRandomValues){ const a=new Uint32Array(1); crypto.getRandomValues(a); j=a[0]%(i+1); }
    else j=Math.floor(Math.random()*(i+1));
    [ids[i],ids[j]]=[ids[j],ids[i]];
  }
  return ids.slice(0,3);
}
function beginPreparation(){
  state.prep.handWarmup={bankVersion:HAND_BANK_VERSION,selectedIds:randomThreeHandIds(),answers:{},currentIndex:0,completed:false,skipped:false};
  save(); navigate('prep');
}
function ensureHandWarmup(){
  if(!state.prep.handWarmup || !Array.isArray(state.prep.handWarmup.selectedIds) || state.prep.handWarmup.selectedIds.length!==3 || state.prep.handWarmup.bankVersion!==HAND_BANK_VERSION){
    state.prep.handWarmup={bankVersion:HAND_BANK_VERSION,selectedIds:randomThreeHandIds(),answers:{},currentIndex:0,completed:false,skipped:false}; save();
  }
  return state.prep.handWarmup;
}
function selectedHands(){ const hw=ensureHandWarmup(); return hw.selectedIds.map(id=>HAND_BANK.find(h=>h.id===id)).filter(Boolean); }
function currentHand(){ const hw=ensureHandWarmup(), hs=selectedHands(); return hs[Math.max(0,Math.min(2,hw.currentIndex||0))]; }
function suitSymbol(s){ return ({s:'♠',h:'♥',d:'♦',c:'♣'})[s]||s; }
function cardHTML(card,small=false){ if(!card)return ''; const rank=card[0], suit=card[1], red=suit==='h'||suit==='d'; return `<span class="playing-card ${small?'small':''} ${red?'red':''}"><b>${rank}</b><span>${suitSymbol(suit)}</span></span>`; }
function boardHTML(cards=[]){ return cards.length?`<div class="board-cards">${cards.map(c=>cardHTML(c,true)).join('')}</div>`:`<div class="preflop-label">Preflop — no board yet</div>`; }
function actionIcon(label){ if(/^Call$/i.test(label))return '<span class="poker-chip" aria-hidden="true"><i></i></span>'; if(/Fold/i.test(label))return '<span class="action-x">×</span>'; if(/^Check$/i.test(label))return '<span class="action-check">✓</span>'; return '<span class="action-up">↑</span>'; }
const TABLE_POSITIONS=['UTG','HJ','CO','BTN','SB','BB'];
function tableSeats(h){
  const heroIndex=TABLE_POSITIONS.indexOf(h.heroPos);
  return TABLE_POSITIONS.map((pos,i)=>{
    const role=pos===h.heroPos?'is-hero':pos===h.villainPos?'is-villain':'';
    const seat=(i-heroIndex+9)%6+1;
    const folded=h.actions.some(a=>a.position===pos&&a.action==='fold');
    return `<div class="gg-seat seat-${seat} ${role} ${folded?'is-folded':''}" aria-label="${pos}${role==='is-hero'?', you':role==='is-villain'?', opponent':''}"><span>${pos}</span>${role?`<small>${role==='is-hero'?'You':'Opponent'}</small>`:''}</div>`;
  }).join('');
}
function handsIntro(){ const hw=ensureHandWarmup(), done=Object.values(hw.answers||{}).filter(a=>a.submitted).length; return appShell(`${header('Hand <span class="accent">Warm-up</span>','Three decisions before your session.')}
  ${stepper(2)}
  <section class="card pad"><strong>${done?`${done} of 3 completed`:'Choose an action. Explain why.'}</strong><p class="body-copy">Practice your thinking with three poker situations. Your hand, the action and your reason stay on one screen.</p></section>
  <button class="btn primary" data-start-hands>${done?'Continue warm-up':'Start warm-up'} <span>→</span></button><button class="btn ghost" data-skip-hands>Skip for now</button>`,'home'); }
function handPlay(){
  const hw=ensureHandWarmup(),h=currentHand();if(!h)return handsIntro();
  const i=hw.currentIndex||0,a=hw.answers?.[h.id]||{};
  const decision=h.toCallBb>0?`${practiceAmount(h.toCallBb)} to call`:h.actions.some(x=>x.street===h.street.toLowerCase()&&x.action==='check')?'Checked to you':'You act first';
  return appShell(`${header(`Hand <span class="accent">${i+1} of 3</span>`,`${h.street} · 6-max cash`)}
    <section class="card pad poker-spot practice-spot">
      <div class="practice-spot-meta"><span>${esc(h.heroPos)} vs ${esc(h.villainPos)}</span><span>${esc(h.effective)} starting stacks</span></div>
      <div class="gg-table practice-table" aria-label="Poker table, you are ${esc(h.heroPos)}">
        <div class="gg-felt"></div>${tableSeats(h)}
        <div class="gg-center"><div class="gg-pot">Pot <strong>${esc(h.pot)}</strong></div>${boardHTML(h.board)}</div>
        <div class="hero-hand-dock"><div class="hole-cards" aria-label="Your cards">${h.heroHand.map(c=>cardHTML(c)).join('')}</div></div>
      </div>
      <div class="practice-history">${h.historyRounds.map(r=>`<div><strong>${esc(r.street)}</strong><span>${esc(r.lines.join(' · '))}</span></div>`).join('')}</div>
      <small class="practice-folds">No rake or antes.</small>
    </section>
    <section class="practice-decision" aria-labelledby="decisionTitle"><div class="row between"><h2 id="decisionTitle" class="section-title">Your action</h2><span class="practice-to-call">${esc(decision)}</span></div>
      <div class="action-options practice-actions" role="group" aria-label="Choose your action">${h.choices.map(c=>`<button type="button" class="poker-action ${a.action===c.value?'selected':''}" data-hand-action="${esc(c.value)}" aria-pressed="${a.action===c.value}" aria-label="${esc(c.value)}"><strong>${esc(c.label)}</strong>${c.detail?`<small>${esc(c.detail)}</small>`:''}</button>`).join('')}</div>
      <label class="practice-why" for="handReason">Why?</label>
      <textarea id="handReason" class="reason-box" maxlength="500" placeholder="What is the main reason for your action?" aria-describedby="reasonError">${esc(a.reason||'')}</textarea>
      <div id="reasonError" class="form-error" role="status"></div>
      <button class="btn primary" data-submit-hand>${i===2?'Finish warm-up':'Next hand'} <span>→</span></button>
    </section>`,'home');
}
// Restore old navigation links on the unified decision screen.
function handExplain(){route='handPlay';return handPlay();}
function choosePracticeAction(action){
  const hw=ensureHandWarmup(),h=currentHand();if(!h?.options.includes(action))return;
  const reason=document.getElementById('handReason')?.value??hw.answers[h.id]?.reason??'';
  hw.answers[h.id]={...(hw.answers[h.id]||{}),action,reason,submitted:false};hw.completed=false;save();
  document.querySelectorAll('[data-hand-action]').forEach(button=>{const selected=button.dataset.handAction===action;button.classList.toggle('selected',selected);button.setAttribute('aria-pressed',String(selected));});
  const error=document.getElementById('reasonError');if(error)error.textContent='';
}
function submitPracticeHand(){
  const hw=ensureHandWarmup(),h=currentHand(),input=document.getElementById('handReason'),error=document.getElementById('reasonError');
  if(!h.options.includes(hw.answers[h.id]?.action)){if(error)error.textContent='Choose an action first.';document.querySelector('[data-hand-action]')?.focus();return;}
  const reason=(input?.value||'').trim();
  if(!reason){if(error)error.textContent='Add a short reason for your action.';input?.focus();return;}
  hw.answers[h.id]={...hw.answers[h.id],reason,submitted:true};
  if((hw.currentIndex||0)>=2){hw.completed=true;hw.skipped=false;save();navigate('handsComplete');}
  else{hw.currentIndex=(hw.currentIndex||0)+1;save();navigate('handPlay');}
}
function handsComplete(){ const hw=ensureHandWarmup(),hs=selectedHands();return appShell(`${header('Warm-up <span class="accent">Complete</span>','Your three decisions.')}
  <div class="stack">${hs.map((h,i)=>{const a=hw.answers?.[h.id]||{};return `<section class="card hand-result"><div><small>HAND ${i+1} · ${esc(h.street.toUpperCase())}</small><strong>${esc(a.action||'—')}</strong><p>${esc(a.reason||'')}</p></div></section>`}).join('')}</div>
  <button class="btn primary" data-nav="review">Continue to session setup <span>→</span></button>`,'home'); }

function review(){ ensurePrepSchedule(); const p=state.prep; const hw=p.handWarmup||{}; const warmupText=hw.completed?'3 hands completed':hw.skipped?'Skipped for this session':'Not completed yet'; return appShell(`${header('Session <span class="accent">Setup</span>','Everything you need before you sit down.')}
  ${stepper(3)}
  <section class="card pad"><button class="prep-item nested" data-nav="handsIntro"><span class="icon">${uiIcon(hw.completed?'check':'cards')}</span><span class="prep-copy"><strong>3-Hand Warm-up</strong><small>${warmupText}</small></span><span class="chev">›</span></button></section>
  <section class="card pad stack"><div class="field"><label>One leak to watch today</label><input type="text" data-prep-text="leak" value="${esc(p.leak)}" placeholder="e.g. Calling too wide vs. 3-bets"></div><div class="field"><label>One reminder for this session</label><input type="text" data-prep-text="reminder" value="${esc(p.reminder)}" placeholder="e.g. Slow down after big pots"></div></section>
  <section class="card pad"><div class="section-title">Game & place</div><div class="stack">
    ${gameField('Game / Stakes','stakes',p.stakes)}
    ${roomField('Room / Site','room',p.room)}
    ${simpleField('Session amount ($)','sessionAmount',p.sessionAmount,'number','Amount you are starting the session with')}
  </div></section>
  <section class="card pad"><div class="section-title">Session window</div><div class="date-time-grid"><div class="field"><label>Start date</label><input type="date" data-prep-text="startDate" value="${esc(p.startDate)}"></div><div class="field"><label>Start time</label><input type="time" data-prep-text="startTime" value="${esc(p.startTime)}"></div><div class="field"><label>End date</label><input type="date" data-prep-text="endDate" value="${esc(p.endDate)}"></div><div class="field"><label>End time</label><input type="time" data-prep-text="endTime" value="${esc(p.endTime)}"></div></div><div class="session-meta top-gap">These are saved with the session and can be edited afterward.</div></section>
  <section class="card pad"><div class="section-title">Guardrails</div><div class="stack">${simpleField('Stop-loss','stopLoss',p.stopLoss,'text')}${simpleField('Target session length','length',p.length,'text')}</div></section>
  <div class="notice"><strong>Hourly reset</strong><br>Once you start, the app will remind you every hour to stop for a 5-minute refresh.</div>
  <div id="startError" class="form-error" aria-live="polite"></div>
  <button class="btn primary" data-start-playing>Start Playing <span>→</span></button>`,'home'); }
function roomField(label,key,val){ return `<div class="field"><label>${label}</label><input type="text" list="knownRooms" data-prep-text="${key}" data-room-input value="${esc(val||'')}" autocomplete="off" placeholder="e.g. GG Poker or Casino Barcelona"><datalist id="knownRooms">${roomOptionsHTML()}</datalist><small class="field-hint">New rooms/sites are remembered automatically.</small></div>`; }
function simpleField(label,key,val,type='text',hint=''){ return `<div class="field"><label>${label}</label><input type="${type}" ${type==='number'?'min="0" step="1" inputmode="decimal"':''} data-prep-text="${key}" value="${esc(val)}">${hint?`<small class="field-hint">${hint}</small>`:''}</div>`; }
function gameField(label,key,val){
  return `<div class="field"><label>${label}</label><input type="text" list="knownGames" data-prep-text="${key}" data-game-input value="${esc(val)}" autocomplete="off"><datalist id="knownGames">${gameOptionsHTML()}</datalist><small class="field-hint">New game names are saved automatically for next time.</small></div>`;
}

function activeSession(){
  const a=state.activeSession;
  if(!a){ route='home'; return home(); }
  const now=Date.now(), elapsed=now-a.startedAt;
  const hourMs=60*60*1000, cycle=elapsed%hourMs, toBreak=hourMs-cycle;
  const nextBreakNumber=Math.floor(elapsed/hourMs)+1;
  return appShell(`${header('Live <span class="accent">Session</span>','Stay with the process. The clock handles the rest.',false)}
    <section class="active-clock-card card pad">
      <div class="live-pill"><span class="live-dot"></span> RUNNING</div>
      <div class="session-clock" id="sessionElapsed">${formatDuration(elapsed)}</div>
      <div class="clock-caption">Time played</div>
      <div class="live-session-card"><div><strong>${esc(a.stakes)}</strong><span>${esc(a.room||'No room')}</span></div><div><small>Started</small><b>${new Date(a.startedAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</b></div></div>
      <div class="break-ring"><div><small>Next 5-min reset</small><strong id="nextBreak">${formatDuration(toBreak)}</strong></div></div>
    </section>
    <section class="card pad session-summary"><div class="summary-row"><span>Started with</span><strong>${money(a.startedAmount)}</strong></div><div class="summary-row"><span>Room</span><strong>${esc(a.room||'—')}</strong></div><div class="summary-row"><span>Date</span><strong>${esc(a.date)}</strong></div></section>
    <div class="goal-review-live"><small>YOUR GOALS</small>${(a.prep?.goals||[]).filter(Boolean).map(g=>`<div>✓ ${esc(g)}</div>`).join('')||'<div>Keep your decisions deliberate.</div>'}</div>
    <section class="card pad active-hands-card"><div class="row between"><div><strong>Session Hands</strong><div class="session-meta">${allSessionHands(a).filter(h=>!h.autoCandidate).length} captured</div></div><button class="btn secondary compact" data-capture-hand>Capture Hand</button></div>${allSessionHands(a).filter(h=>!h.autoCandidate).length?'<button class="session-hands-link" data-open-active-hands>View saved hands →</button>':''}</section>
    <button class="btn primary" data-finish-session>Finish Session <span>→</span></button>
    <button class="btn ghost" data-nav="home">Back to Home</button>`, 'home');
}
function startSessionTicker(){ stopSessionTicker(); if(route!=='active'||!state.activeSession)return; sessionTicker=setInterval(()=>{ const a=state.activeSession;if(!a)return;const elapsed=Date.now()-a.startedAt;const hourMs=3600000;const toBreak=hourMs-(elapsed%hourMs); const e=document.getElementById('sessionElapsed'),b=document.getElementById('nextBreak'); if(e)e.textContent=formatDuration(elapsed); if(b)b.textContent=formatDuration(toBreak); },1000); }
function stopSessionTicker(){ if(sessionTicker)clearInterval(sessionTicker); sessionTicker=null; }

function logSession(){ const a=state.activeSession; const endNow=Date.now(); const startMs=a?.startedAt ?? endNow-2*3600000; const endMs=endNow; return appShell(`${header('End <span class="accent">Session</span>','Results are data. The review is the work.')}
  <form id="logForm" class="stack">
   <section class="card pad stack"><div class="field"><label>Game / Stakes</label><input name="game" type="text" list="knownGamesLog" data-game-input value="${esc(a?.stakes||state.prep.stakes||'NL100')}" required autocomplete="off"><datalist id="knownGamesLog">${gameOptionsHTML()}</datalist></div><div class="field"><label>Room / Site</label><input name="room" type="text" list="knownRoomsLog" data-room-input value="${esc(a?.room||state.prep.room||'')}" autocomplete="off"><datalist id="knownRoomsLog">${roomOptionsHTML()}</datalist></div><div class="date-time-grid"><div class="field span-2"><label>Started</label><input name="startAt" type="datetime-local" value="${localDateTimeValue(startMs)}" required></div><div class="field span-2"><label>Ended</label><input name="endAt" type="datetime-local" value="${localDateTimeValue(endMs)}" required></div></div><div class="money-grid"><div class="field"><label>Started with ($)</label><input name="started" type="number" min="0" step="1" inputmode="decimal" value="${esc(a?.startedAmount??'')}" required></div><div class="field"><label>Finished with ($)</label><input name="finished" type="number" min="0" step="1" inputmode="decimal" required></div></div></section>
   <section class="card pad"><div class="section-title">Goals review</div><div class="saved-goals">${(a?.prep?.goals||state.prep.goals||[]).filter(Boolean).map(g=>`<div><span>✓</span>${esc(g)}</div>`).join('')||'<div class="session-meta">No goals were set.</div>'}</div></section>
   <section class="card pad"><div class="section-title">Inner Game Review</div>${rangeRow('Process','process',7)}${rangeRow('Self-judgment','judgment',4)}${rangeRow('Tilt','tilt',3)}${rangeRow('Trust','trust',7)}</section>
   <section class="card pad session-reflection-form">
     <div class="section-title">Session reflection</div>
     <p class="session-reflection-intro">Three quick prompts. Keep them concrete.</p>
     <div class="field"><label>Best decision</label><textarea name="bestDecision" placeholder="A decision or moment you want to repeat."></textarea></div>
     <div class="field"><label>Toughest moment</label><textarea name="toughestSpot" placeholder="Where did your process slip or get tested?"></textarea></div>
     <div class="field"><label>One takeaway</label><textarea name="takeaway" placeholder="What do you want to carry into the next session?"></textarea></div>
     <div class="field"><label>Session note <span class="optional-label">optional</span></label><textarea name="note" placeholder="Anything else worth remembering."></textarea></div>
   </section>
   <button class="btn primary" type="submit">Save Review</button>
  </form>`,'sessions'); }


function filterMoneySessions(){
  let rows=[...state.sessions].sort((a,b)=>String(a.date).localeCompare(String(b.date)));
  if(moneyGame!=='all') rows=rows.filter(s=>s.game===moneyGame);
  if(moneyRange!=='all'){
    const days=Number(moneyRange), cutoff=new Date(); cutoff.setHours(0,0,0,0); cutoff.setDate(cutoff.getDate()-days+1);
    rows=rows.filter(s=>{const d=new Date(`${s.date}T00:00:00`);return !Number.isNaN(d.valueOf())&&d>=cutoff;});
  }
  return rows;
}
function moneyGraph(){
  const rows=filterMoneySessions(), cumulative=[0]; let total=0;
  rows.forEach(s=>{total+=Number(s.pnl)||0;cumulative.push(total);});
  const values=cumulative.length>1?cumulative:[0,0], min=Math.min(...values,0), max=Math.max(...values,0), span=Math.max(1,max-min);
  const W=360,H=178,P=18;
  const points=values.map((v,i)=>{const x=P+(i/(values.length-1||1))*(W-P*2);const y=P+((max-v)/span)*(H-P*2);return [x,y];});
  const path=points.map((p,i)=>`${i?'L':'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const zeroY=(P+((max-0)/span)*(H-P*2)).toFixed(1);
  const firstDate=rows[0]?.date||'—', lastDate=rows.at(-1)?.date||'—';
  const best=rows.length?rows.reduce((a,b)=>(Number(b.pnl)||0)>(Number(a.pnl)||0)?b:a,rows[0]):null;
  const worst=rows.length?rows.reduce((a,b)=>(Number(b.pnl)||0)<(Number(a.pnl)||0)?b:a,rows[0]):null;
  const bars=rows.map((s,i)=>{const p=points[i+1],zero=Number(zeroY),val=Number(s.pnl)||0,y=Math.min(p[1],zero),h=Math.max(2,Math.abs(p[1]-zero));return `<rect class="session-bar ${val>=0?'win':'loss'}" x="${Math.max(P,p[0]-3)}" y="${y}" width="6" height="${h}" rx="3"/>`;}).join('');
  const dots=rows.map((s,i)=>{const [x,y]=points[i+1];return `<circle class="money-dot" cx="${x}" cy="${y}" r="4"/><circle class="money-hit" data-money-point="${i}" cx="${x}" cy="${y}" r="16"/>`;}).join('');
  return `<section class="card pad bankroll-card">
    <div class="row between section-head"><div><div class="section-title">Bankroll</div><div class="session-meta">Tap any point for session details</div></div><div class="money-total"><strong class="${total>=0?'positive':'negative'}">${money(total)}</strong><small>${rows.length} sessions</small></div></div>
    <div class="money-filters"><div class="range-pills">${[['7','1W'],['30','1M'],['90','3M'],['all','All']].map(([v,l])=>`<button class="${moneyRange===v?'active':''}" data-money-range="${v}">${l}</button>`).join('')}</div>
    <select id="moneyGameFilter" aria-label="Filter graph by game"><option value="all">All games</option>${knownGames().map(g=>`<option value="${esc(g)}" ${moneyGame===g?'selected':''}>${esc(g)}</option>`).join('')}</select></div>
    <div class="money-chart-wrap">${rows.length?`<div id="moneyTooltip" class="money-tooltip hidden"></div><svg class="money-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Cumulative profit and loss graph"><defs><linearGradient id="moneyFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#37e7b0" stop-opacity=".30"/><stop offset="100%" stop-color="#5b7cfa" stop-opacity=".02"/></linearGradient></defs><line class="money-zero" x1="${P}" y1="${zeroY}" x2="${W-P}" y2="${zeroY}"/>${bars}<path class="money-area" d="${path} L ${points.at(-1)[0]},${H-P} L ${points[0][0]},${H-P} Z"/><path class="money-line" d="${path}"/>${dots}</svg>`:`<div class="empty graph-empty">No sessions match these filters.</div>`}</div>
    ${rows.length?`<div class="graph-fun-stats"><div><small>Best</small><strong class="positive">${money(best?.pnl||0)}</strong></div><div><small>Worst</small><strong class="negative">${money(worst?.pnl||0)}</strong></div><div><small>Win rate</small><strong>${Math.round(rows.filter(s=>s.pnl>0).length/rows.length*100)}%</strong></div></div>`:''}
    <div class="graph-footer"><span>${esc(firstDate)}</span><span>Swipe / tap points</span><span>${esc(lastDate)}</span></div>
  </section>`;
}
function showMoneyPoint(i){
  const rows=filterMoneySessions(), s=rows[Number(i)], tip=document.getElementById('moneyTooltip'); if(!s||!tip)return;
  const cumulative=rows.slice(0,Number(i)+1).reduce((a,x)=>a+(Number(x.pnl)||0),0);
  tip.innerHTML=`<small>${esc(s.date)} · ${esc(s.game)}${s.room?` · ${esc(s.room)}`:''}</small><strong class="${s.pnl>=0?'positive':'negative'}">${money(s.pnl)}</strong><span>Cumulative ${money(cumulative)}</span>`;
  tip.classList.remove('hidden');
}
function sessionDeleteModal(){
  if(!pendingDeleteSessionId)return '';
  const item=state.sessions.find(x=>x.id===pendingDeleteSessionId);
  if(!item){pendingDeleteSessionId=null;return '';}
  return `<div class="modal-backdrop" role="presentation"><section class="confirm-sheet" role="dialog" aria-modal="true" aria-labelledby="deleteTitle"><div class="danger-icon">×</div><h2 id="deleteTitle">Delete this session?</h2><p>${esc(item.game)} · ${esc(item.date)} · ${money(item.pnl)}<br>This cannot be undone.</p><div class="confirm-actions"><button class="btn secondary" type="button" data-cancel-delete>Keep Session</button><button class="btn danger" type="button" data-confirm-delete>Delete Session</button></div></section></div>`;
}
function gamificationPanel(){
  const g=gamificationStats(), unlocked=g.achievements.filter(a=>a.on).length;
  return `<section class="card pad progress-card"><div class="row between"><div><small class="eyebrow">PROGRESS</small><div class="section-title compact-title">Level ${g.level}</div></div><div class="xp-badge">${g.xp} XP</div></div><div class="xp-track big"><i style="width:${g.progress*100}%"></i></div><div class="row between session-meta"><span>${g.aStreak} session A-game streak</span><span>${unlocked}/${g.achievements.length} badges</span></div><div class="achievement-grid">${g.achievements.map(a=>`<div class="achievement ${a.on?'unlocked':'locked'}"><span>${symbolIcon(a.icon)}</span><strong>${a.name}</strong><small>${a.desc}</small></div>`).join('')}</div></section>`;
}
function sessions(){
  const list=[...state.sessions].reverse();
  return appShell(`${header('Sessions','Track your play. Find progress.',false)}
  ${handsSwitcher('sessions')}
  ${moneyGraph()}
  <section class="card pad"><div class="metrics"><div class="metric"><small>Total Sessions</small><strong>${list.length}</strong></div><div class="metric"><small>Avg Process Score</small><strong>${list.length?avg(list.map(x=>x.process)).toFixed(1):'—'}<span class="session-meta"> / 10</span></strong></div></div></section>
  <div class="section-title list-heading">Recent Sessions</div><section class="session-list session-list-cards">${list.length?list.map(sessionRow).join(''):'<div class="card empty">No sessions yet. Log one after you play.</div>'}</section>
  ${sessionDeleteModal()}`,'sessions');
}
function sessionWhenLabel(s){
  if(!s.startAt)return s.date||'';
  const d=new Date(s.startAt), now=new Date();
  const sameDay=(a,b)=>a.getFullYear()===b.getFullYear()&&a.getMonth()===b.getMonth()&&a.getDate()===b.getDate();
  const yesterday=new Date(now); yesterday.setDate(now.getDate()-1);
  const time=d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
  if(sameDay(d,now))return `Today, ${time}`;
  if(sameDay(d,yesterday))return `Yesterday, ${time}`;
  return `${d.toLocaleDateString([], {day:'numeric',month:'short'})}, ${time}`;
}
function compactSessionDuration(ms){
  if(!(Number(ms)>0))return '';
  const minutes=Math.max(1,Math.round(Number(ms)/60000)), hours=Math.floor(minutes/60), rest=minutes%60;
  return hours?`${hours}h ${String(rest).padStart(2,'0')}m`:`${minutes}m`;
}
function sessionRoomThumb(room=''){
  const raw=String(room||'').trim(), key=raw.toLowerCase();
  let label='♠', kind='default';
  if(key.includes('gg')){label='GG';kind='gg';}
  else if(key.includes('wpt')){label='W';kind='wpt';}
  else if(key.includes('pokerstars')||key.includes('stars')){label='★';kind='stars';}
  else if(key.includes('coinpoker')){label='CP';kind='coin';}
  else if(key.includes('888')){label='888';kind='eight';}
  else if(raw){label=(raw.match(/[A-Za-z0-9]/g)||[]).slice(0,2).join('').toUpperCase()||'♠';}
  return `<div class="session-room-thumb ${kind}" aria-hidden="true"><span>${esc(label)}</span></div>`;
}
function sessionRow(s){
  const when=sessionWhenLabel(s), duration=compactSessionDuration(s.durationMs), hands=allSessionHands(s).length;
  const pnl=Number(s.pnl)||0, pnlClass=pnl>0?'positive':pnl<0?'negative':'neutral';
  const meta=[when,s.room,duration].filter(Boolean).join(' · ');
  return `<div class="session-row session-card-row" data-open-session="${esc(s.id)}" role="button" tabindex="0" aria-label="Open ${esc(s.game)} session">
    ${sessionRoomThumb(s.room)}
    <div class="session-card-main">
      <div class="session-card-top"><h3>${esc(s.game)}</h3><div class="session-pnl ${pnlClass}">${money(pnl)}</div></div>
      <div class="session-meta session-card-meta">${esc(meta)}</div>
      <div class="session-card-stats">
        <span class="session-stat process"><i></i><span>Process</span><strong>${esc(s.process)}</strong></span>
        <span class="session-stat tilt"><i></i><span>Tilt</span><strong>${esc(s.tilt)}</strong></span>
        <span class="session-hand-count" aria-label="${hands} saved hands"><svg viewBox="0 0 20 20" aria-hidden="true"><rect x="4.5" y="3.5" width="11" height="13" rx="2"></rect><path d="M7 1.8h6M7.5 7.2h5M7.5 10.2h5"></path></svg>${hands} hand${hands===1?'':'s'}</span>
        <span class="session-row-chevron" aria-hidden="true">›</span>
      </div>
    </div>
  </div>`;
}
function sessionDetail(){
  const s=state.sessions.find(x=>x.id===editingSessionId); if(!s){route='sessions';return sessions();}
  const hands=allSessionHands(s).filter(h=>!h.autoCandidate);
  const reflection=[
    ['Best decision',s.bestDecision],
    ['Toughest moment',s.toughestSpot],
    ['One takeaway',s.takeaway]
  ].filter(([,v])=>(v||'').trim());
  return appShell(`${header('Session <span class="accent">Review</span>',`${esc(s.date)} · ${esc(s.game)}`)}
    <section class="card pad session-detail-top">
      <div class="session-review-score-grid">
        <div><small>RESULT</small><strong class="${s.pnl>=0?'positive':'negative'}">${money(s.pnl)}</strong></div>
        <div><small>PROCESS</small><strong>${s.process}/10</strong></div>
        <div><small>TILT</small><strong>${s.tilt}/10</strong></div>
      </div>
      <div class="session-meta top-gap">${esc([s.room,s.state,s.durationMs?formatDuration(s.durationMs):null].filter(Boolean).join(' · '))}</div>
    </section>
    ${reflection.length||s.note?`<section class="card pad session-reflection-card"><div class="section-title">What to remember</div>${reflection.map(([label,value])=>`<div class="reflection-item"><small>${esc(label)}</small><p>${esc(value)}</p></div>`).join('')}${s.note?`<div class="reflection-item note"><small>Session note</small><p>${esc(s.note)}</p></div>`:''}</section>`:''}
    <section class="card pad session-hands-destination" data-open-session-hands="${esc(s.id)}" role="button" tabindex="0"><div class="row between"><div><div class="section-title">Saved Hands</div><div class="session-meta">${hands.length} captured during this session</div></div>${hands.length?'<span class="session-hands-chevron">›</span>':''}</div><div class="session-hand-preview">${hands.slice(-3).reverse().map(h=>handCard(h)).join('')||'<div class="empty">No hands captured in this session.</div>'}</div></section>
    <button class="btn secondary" data-edit-session="${esc(s.id)}">Edit Session</button>`,'sessions');
}
function editSession(){
  const s=state.sessions.find(x=>x.id===editingSessionId);
  if(!s){editingSessionId=null; route='sessions'; return sessions();}
  const startMs=s.startAt||new Date(`${s.date}T12:00:00`).valueOf(), endMs=s.endAt||((startMs||Date.now())+(s.durationMs||2*3600000));
  return appShell(`${header('Edit <span class="accent">Session</span>','Correct anything that changed.')}
  <form id="editSessionForm" class="stack">
   <section class="card pad stack"><div class="field"><label>Game / Stakes</label><input name="game" type="text" list="knownGamesEdit" data-game-input value="${esc(s.game)}" required autocomplete="off"><datalist id="knownGamesEdit">${gameOptionsHTML()}</datalist></div><div class="field"><label>Room / Site</label><input name="room" type="text" list="knownRoomsEdit" data-room-input value="${esc(s.room||'')}" autocomplete="off"><datalist id="knownRoomsEdit">${roomOptionsHTML()}</datalist></div><div class="field"><label>Started</label><input name="startAt" type="datetime-local" value="${localDateTimeValue(startMs)}" required></div><div class="field"><label>Ended</label><input name="endAt" type="datetime-local" value="${localDateTimeValue(endMs)}" required></div><div class="money-grid"><div class="field"><label>Started with ($)</label><input name="started" type="number" min="0" step="1" value="${esc(s.started)}" required></div><div class="field"><label>Finished with ($)</label><input name="finished" type="number" min="0" step="1" value="${esc(s.finished)}" required></div></div></section>
   <section class="card pad"><div class="section-title">Inner Game Review</div>${rangeRow('Process','edit-process',s.process)}${rangeRow('Self-judgment','edit-judgment',s.judgment)}${rangeRow('Tilt','edit-tilt',s.tilt)}${rangeRow('Trust','edit-trust',s.trust)}</section>
   <section class="card pad session-reflection-form"><div class="section-title">Session reflection</div><div class="field"><label>Best decision</label><textarea name="bestDecision">${esc(s.bestDecision||'')}</textarea></div><div class="field"><label>Toughest moment</label><textarea name="toughestSpot">${esc(s.toughestSpot||'')}</textarea></div><div class="field"><label>One takeaway</label><textarea name="takeaway">${esc(s.takeaway||'')}</textarea></div><div class="field"><label>Session note</label><textarea name="note">${esc(s.note||'')}</textarea></div></section>
   <button class="btn primary" type="submit">Save Changes</button><button class="btn ghost danger-text" type="button" data-delete-session="${esc(s.id)}">Delete Session</button>
  </form>${sessionDeleteModal()}`,'sessions');
}
function processBucketLabel(v){return v>=8?'Strong':v>=6?'Okay':'Needs attention'}
function simpleCompare(title, leftLabel,leftValue,rightLabel,rightValue, insight){
  const max=Math.max(1,leftValue,rightValue); const lp=Math.max(8,leftValue/max*100), rp=Math.max(8,rightValue/max*100);
  return `<section class="card pad simple-insight"><div class="section-title">${title}</div><div class="compare-bars"><div class="compare-row"><span>${leftLabel}</span><div class="bar-track"><i style="width:${lp}%"></i></div><strong>${leftValue.toFixed(1)}</strong></div><div class="compare-row"><span>${rightLabel}</span><div class="bar-track"><i style="width:${rp}%"></i></div><strong>${rightValue.toFixed(1)}</strong></div></div><p class="plain-insight">${insight}</p></section>`;
}
function insights(){
  const ss=state.sessions;
  if(ss.length<3) return appShell(`${header('Insights','Simple patterns from your sessions.',false)}<div class="notice"><strong>Not enough data yet.</strong><br>Log at least 3 sessions and we’ll start showing clear, plain-English patterns.</div>`,'insights');
  const lowTilt=ss.filter(x=>x.tilt<=4), highTilt=ss.filter(x=>x.tilt>=7);
  const calm=ss.filter(x=>x.state==='Calm'||x.state==='Focused'), tense=ss.filter(x=>x.state==='Tense'||x.state==='Tilted');
  const lowJudgment=ss.filter(x=>x.judgment<=4), highJudgment=ss.filter(x=>x.judgment>=7);
  const allProcess=avg(ss.map(x=>x.process));
  const best=ss.slice().sort((a,b)=>b.process-a.process)[0];
  const cards=[];
  if(lowTilt.length&&highTilt.length){const a=avg(lowTilt.map(x=>x.process)),b=avg(highTilt.map(x=>x.process));cards.push(simpleCompare('Tilt vs. decision quality','Low tilt',a,'High tilt',b,a>b?`You tend to play ${Math.abs(a-b).toFixed(1)} process points better when tilt stays low.`:`Your process score is currently similar regardless of tilt.`));}
  if(calm.length&&tense.length){const a=avg(calm.map(x=>x.process)),b=avg(tense.map(x=>x.process));cards.push(simpleCompare('Mental state vs. process','Calm / focused',a,'Tense / tilted',b,a>b?'Your calmer sessions have produced better decision quality so far.':'There is not a clear mental-state pattern yet.'));}
  if(lowJudgment.length&&highJudgment.length){const a=avg(lowJudgment.map(x=>x.process)),b=avg(highJudgment.map(x=>x.process));cards.push(simpleCompare('Self-judgment vs. process','Less judgment',a,'More judgment',b,a>b?'Being less self-critical is associated with better process in your saved sessions.':'No clear relationship yet between self-judgment and process.'));}
  return appShell(`${header('Insights','Understand your game without reading a statistics textbook.',false)}
    <section class="card pad insight-hero"><small>Your average process score</small><strong>${allProcess.toFixed(1)}<span>/10</span></strong><div class="process-pill">${processBucketLabel(allProcess)}</div><p>${best?`Your strongest saved session was ${best.process}/10 on ${esc(best.date)}.`:''}</p></section>
    <div class="stack">${cards.length?cards.join(''):'<div class="notice"><strong>No strong comparison yet.</strong><br>Keep logging sessions. We only show a comparison when both sides have enough examples.</div>'}</div>
    <div class="notice"><strong>What to focus on next</strong><br>${recommendation(ss)}</div>`,'insights');
}
function recommendation(ss){ if(ss.length<3)return 'Keep the routine consistent for a few sessions. The app will surface patterns once there is enough data.'; const c=corr(ss.map(x=>x.judgment),ss.map(x=>x.process)); if(c!==null&&c<-.25)return 'Try replacing self-criticism with one neutral observation after a difficult hand.'; const t=corr(ss.map(x=>x.tilt),ss.map(x=>x.process)); if(t!==null&&t<-.25)return 'Protect your process when tilt rises: use the hourly reset or end the session if you stop following your plan.'; return 'Keep one clear process goal per session and compare it with your post-session process score.'; }

function profile(){ return appShell(`${header('Your game','Make the process yours.',false)}<div class="stack"><section class="card pad profile-identity"><img src="brand-icon.png" alt="Inner Game" class="profile-brand-icon"><div><small class="eyebrow">PLAYER PROFILE</small><h2>${esc(state.profile.name)}</h2><p>Show up clear. Play with purpose.</p></div></section><form id="profileForm" class="card pad"><div class="section-title">Personalize your space</div><div class="profile-name-form"><div class="field"><label for="profileName">Your name</label><input id="profileName" name="name" type="text" autocomplete="given-name" maxlength="32" required value="${esc(state.profile.name)}"></div><button class="btn secondary" type="submit">Save name</button></div></form>${gamificationPanel()}<section class="card pad"><div class="section-title title-with-icon">${uiIcon('shield')}Your data</div><p class="body-copy">Your sessions, preparation, saved hands, and insights live on this device. Screenshot reconstruction and solver analysis use an online service. Export your data to keep a backup.</p><div class="settings-actions"><button class="btn secondary" id="exportData">${uiIcon('download')}Export my data</button><button class="btn secondary" id="seedDemo">${uiIcon('spark')}Explore demo sessions</button><button class="btn secondary danger-text" id="clearData">${uiIcon('trash')}Clear local data</button></div></section><p class="brand-footer">innergame · YOUR GAME. YOUR PROCESS.</p></div>`,'profile'); }

function render(){
  const app=document.getElementById('app');
  app.innerHTML = ({home,prep:prepOverview,breathe,goals,handsIntro,handPlay,handExplain,handsComplete,review,active:activeSession,log:logSession,sessions,sessionDetail,editSession,insights,captureReview,sessionHands,handsLibrary,handDetail,solverReview,solverResult,profile}[route]||home)();
  // All field variants use the same control styles and accessible label link.
  app.querySelectorAll('.field').forEach((field,index)=>{
    const control=field.querySelector('input,select,textarea'),label=field.querySelector('label');
    if(!control||!label)return;
    control.classList.add('form-control');
    if(!control.id)control.id=`${route}-field-${index}`;
    label.htmlFor=control.id;
  });
  bind();hydrateHandImages();if(route==='active')startSessionTicker();
}
function bind(){
  const profileForm=document.getElementById('profileForm');if(profileForm)profileForm.onsubmit=e=>{e.preventDefault();const name=document.getElementById('profileName').value.trim().slice(0,32);if(!name)return;state.profile.name=name;save();render();captureToast('Your name is saved.');};
  document.querySelectorAll('[data-nav]').forEach(el=>el.onclick=()=>navigate(el.dataset.nav));
  document.querySelectorAll('[data-back]').forEach(el=>el.onclick=()=>navigate(route==='solverReview'||route==='solverResult'?'handDetail':route==='handDetail'?handReturnRoute:route==='handsLibrary'?'sessions':route==='sessionDetail'?'sessions':route==='sessionHands'?(selectedSessionHandsId==='active'?'active':'sessions'):route==='captureReview'?(selectedHandId?'handDetail':'active'):route==='editSession'?'sessions':route==='log'||route==='active'?'home':route==='breathe'?'prep':route==='goals'?'breathe':route==='handsIntro'?'goals':route==='handPlay'?'handsIntro':route==='handExplain'?'handPlay':route==='handsComplete'?'handsIntro':route==='review'?'handsIntro':'home'));
  document.querySelectorAll('[data-start-prep]').forEach(el=>el.onclick=beginPreparation);
  document.querySelectorAll('[data-breath-level]').forEach(el=>el.onclick=()=>{ breathLevel=el.dataset.breathLevel; state.prep.breathLevel=breathLevel; save(); resetBreath(); });
  document.querySelectorAll('[data-breath-workout]').forEach(el=>el.onclick=()=>{ breathWorkout=el.dataset.breathWorkout; state.prep.breathWorkout=breathWorkout; save(); resetBreath(); });
  const toggle=document.getElementById('breathToggle'); if(toggle)toggle.onclick=()=>breathRunning?(stopBreath(),render()):startBreath();
  const reset=document.getElementById('breathReset'); if(reset)reset.onclick=resetBreath;
  const comp=document.querySelector('[data-complete-breath]'); if(comp)comp.onclick=()=>{stopBreath();state.prep.breathLevel=breathLevel;state.prep.breathWorkout=breathWorkout;save();navigate('goals')};
  document.querySelectorAll('[data-goal-input]').forEach(el=>el.oninput=()=>{ const i=Number(el.dataset.goalInput); while(state.prep.goals.length<3)state.prep.goals.push(''); state.prep.goals[i]=el.value; save(); });
  document.querySelectorAll('[data-range]').forEach(el=>el.oninput=()=>{ const k=el.dataset.range, v=Number(el.value); if(['energy','focus','noise'].includes(k))state.prep[k]=v; const out=document.getElementById(`v-${k}`); if(out)out.textContent=v; save(); });
  document.querySelectorAll('[data-env]').forEach(el=>el.onclick=()=>{ const k=el.dataset.env; state.prep.environment[k]=!state.prep.environment[k]; save(); render(); });
  document.querySelectorAll('[data-prep-text]').forEach(el=>el.oninput=()=>{state.prep[el.dataset.prepText]=el.value;save();});
  document.querySelectorAll('[data-room-input]').forEach(el=>{ const commit=()=>{const v=normalizeRoomName(el.value); if(v){el.value=v; rememberRoom(v); if(el.dataset.prepText)state.prep[el.dataset.prepText]=v; save();}}; el.addEventListener('change',commit); el.addEventListener('blur',commit); });
  document.querySelectorAll('[data-game-input]').forEach(el=>{
    const commit=()=>{const v=normalizeGameName(el.value); if(v){el.value=v; rememberGame(v); if(el.dataset.prepText)state.prep[el.dataset.prepText]=v; save();}};
    el.addEventListener('change',commit); el.addEventListener('blur',commit);
  });
  const startHands=document.querySelector('[data-start-hands]'); if(startHands)startHands.onclick=()=>{ const hw=ensureHandWarmup(); const hs=selectedHands(); let next=hs.findIndex(h=>!hw.answers?.[h.id]?.submitted); if(next<0)next=0; hw.currentIndex=next; save(); navigate('handPlay'); };
  const skipHands=document.querySelector('[data-skip-hands]'); if(skipHands)skipHands.onclick=()=>{ const hw=ensureHandWarmup(); hw.skipped=true; hw.completed=false; save(); navigate('review'); };
  document.querySelectorAll('[data-hand-action]').forEach(el=>el.onclick=()=>choosePracticeAction(el.dataset.handAction));
  const handReason=document.getElementById('handReason');if(handReason)handReason.oninput=()=>{const hw=ensureHandWarmup(),h=currentHand();hw.answers[h.id]={...(hw.answers[h.id]||{}),reason:handReason.value,submitted:false};hw.completed=false;save();};
  const submitHand=document.querySelector('[data-submit-hand]');if(submitHand)submitHand.onclick=submitPracticeHand;
  const start=document.querySelector('[data-start-playing]'); if(start)start.onclick=()=>{
    const amount=Number(state.prep.sessionAmount);
    const err=document.getElementById('startError');
    if(!Number.isFinite(amount)||amount<=0){ if(err)err.textContent='Enter the amount you are starting the session with.'; document.querySelector('[data-prep-text="sessionAmount"]')?.focus(); return; }
    ensurePrepSchedule(); rememberGame(state.prep.stakes); rememberRoom(state.prep.room); state.activeSession={id:crypto.randomUUID?.()||String(Date.now()),startedAt:Date.now(),date:localDateValue(),stakes:normalizeGameName(state.prep.stakes),room:normalizeRoomName(state.prep.room),startedAmount:amount,plannedStart:`${state.prep.startDate}T${state.prep.startTime}`,plannedEnd:`${state.prep.endDate}T${state.prep.endTime}`,prep:structuredClone(state.prep),hands:[]};
    save(); scheduleBreakReminders(); navigate('active');
  };
  document.querySelectorAll('[data-finish-session]').forEach(el=>el.onclick=()=>navigate('log'));
  const f=document.getElementById('logForm'); if(f)f.onsubmit=e=>{
    e.preventDefault(); const fd=new FormData(f), started=Number(fd.get('started')),finished=Number(fd.get('finished'));
    const process=Number(document.querySelector('[data-range="process"]')?.value||7), judgment=Number(document.querySelector('[data-range="judgment"]')?.value||4), tilt=Number(document.querySelector('[data-range="tilt"]')?.value||3), trust=Number(document.querySelector('[data-range="trust"]')?.value||7);
    const mental=state.activeSession?.prep; const scoreState = tilt>=8?'Tilted':(mental?.noise??5)<=3&&tilt<=4?'Calm':trust>=7?'Focused':'Tense';
    const durationMs=state.activeSession?Date.now()-state.activeSession.startedAt:null;
    const startAt=parseLocalDateTime(fd.get('startAt')), endAt=parseLocalDateTime(fd.get('endAt')); if(!startAt||!endAt||endAt<startAt)return;
    const room=normalizeRoomName(fd.get('room')); rememberGame(fd.get('game')); rememberRoom(room);
    const completedSessionId=state.activeSession?.id||crypto.randomUUID?.()||String(Date.now());
    const completedHands=allSessionHands(state.activeSession).map(h=>({...h,sessionId:completedSessionId}));
    state.sessions.push({id:completedSessionId,date:localDateValue(startAt),startAt,endAt,captureStartedAt:state.activeSession?.startedAt||startAt,captureEndedAt:Date.now(),room,game:normalizeGameName(fd.get('game')),started,finished,pnl:finished-started,process,judgment,tilt,trust,state:scoreState,note:fd.get('note'),bestDecision:fd.get('bestDecision'),toughestSpot:fd.get('toughestSpot'),takeaway:fd.get('takeaway'),prep:mental||null,durationMs:endAt-startAt,hands:completedHands});
    state.activeSession=null; save(); cancelBreakReminders(); editingSessionId=completedSessionId; navigate('sessionDetail');
  };
  const sound=document.getElementById('breathSound'); if(sound)sound.onclick=()=>{breathSoundEnabled=!breathSoundEnabled; if(breathSoundEnabled)ensureBreathAudio(); render();};
  document.querySelectorAll('[data-edit-session]').forEach(el=>el.onclick=()=>{editingSessionId=el.dataset.editSession;navigate('editSession');});
  document.querySelectorAll('[data-delete-session]').forEach(el=>el.onclick=()=>{pendingDeleteSessionId=el.dataset.deleteSession;render();});
  const cancelDelete=document.querySelector('[data-cancel-delete]'); if(cancelDelete)cancelDelete.onclick=()=>{pendingDeleteSessionId=null;render();};
  const confirmDelete=document.querySelector('[data-confirm-delete]'); if(confirmDelete)confirmDelete.onclick=()=>{
    const id=pendingDeleteSessionId; if(!id)return;
    state.sessions=state.sessions.filter(x=>x.id!==id); pendingDeleteSessionId=null;
    if(editingSessionId===id){editingSessionId=null;route='sessions';}
    save(); render();
  };
  const editForm=document.getElementById('editSessionForm'); if(editForm)editForm.onsubmit=e=>{
    e.preventDefault(); const item=state.sessions.find(x=>x.id===editingSessionId); if(!item)return navigate('sessions'); const fd=new FormData(editForm),started=Number(fd.get('started')),finished=Number(fd.get('finished'));
    const process=Number(document.querySelector('[data-range="edit-process"]')?.value||item.process),judgment=Number(document.querySelector('[data-range="edit-judgment"]')?.value||item.judgment),tilt=Number(document.querySelector('[data-range="edit-tilt"]')?.value||item.tilt),trust=Number(document.querySelector('[data-range="edit-trust"]')?.value||item.trust);
    const startAt=parseLocalDateTime(fd.get('startAt')), endAt=parseLocalDateTime(fd.get('endAt')); if(!startAt||!endAt||endAt<startAt)return; const room=normalizeRoomName(fd.get('room')); rememberGame(fd.get('game')); rememberRoom(room); Object.assign(item,{date:localDateValue(startAt),startAt,endAt,durationMs:endAt-startAt,room,game:normalizeGameName(fd.get('game')),started,finished,pnl:finished-started,process,judgment,tilt,trust,note:fd.get('note'),bestDecision:fd.get('bestDecision'),toughestSpot:fd.get('toughestSpot'),takeaway:fd.get('takeaway')}); item.state=tilt>=8?'Tilted':(item.prep?.noise??5)<=3&&tilt<=4?'Calm':trust>=7?'Focused':'Tense'; save(); editingSessionId=null; navigate('sessions');
  };
  document.querySelectorAll('[data-money-range]').forEach(el=>el.onclick=()=>{moneyRange=el.dataset.moneyRange;render();});
  const moneyGameFilter=document.getElementById('moneyGameFilter'); if(moneyGameFilter)moneyGameFilter.onchange=()=>{moneyGame=moneyGameFilter.value;render();};
  document.querySelectorAll('[data-money-point]').forEach(el=>{ el.onpointerenter=()=>showMoneyPoint(el.dataset.moneyPoint); el.onclick=()=>showMoneyPoint(el.dataset.moneyPoint); });
  const captureBtn=document.querySelector('[data-capture-hand]'); if(captureBtn)captureBtn.onclick=triggerNativeCapture;
  const openActiveHands=document.querySelector('[data-open-active-hands]'); if(openActiveHands)openActiveHands.onclick=()=>{selectedSessionHandsId='active';navigate('sessionHands');};
  document.querySelectorAll('[data-open-session]').forEach(el=>{const open=()=>{editingSessionId=el.dataset.openSession;navigate('sessionDetail');};el.onclick=e=>{if(e.target.closest('button'))return;open();};el.onkeydown=e=>{if(e.target!==el)return;if(e.key==='Enter'||e.key===' '){e.preventDefault();open();}};});
  document.querySelectorAll('[data-hands-filter]').forEach(el=>el.onclick=()=>{handsFilter=el.dataset.handsFilter;render();});
  const search=document.getElementById('handsSearch');if(search)search.oninput=()=>{const caret=search.selectionStart;handsSearch=search.value;render();const replacement=document.getElementById('handsSearch');replacement.focus({preventScroll:true});if(caret!==null)replacement.setSelectionRange(caret,caret);};
  const upload=document.getElementById('handUpload'),uploadButton=document.querySelector('[data-upload-hand]');if(upload&&uploadButton){uploadButton.onclick=()=>upload.click();upload.onchange=()=>importHandScreenshot(upload.files[0]);}
  const dropZone=document.getElementById('handDropZone'); if(dropZone){dropZone.ondragover=e=>{e.preventDefault();dropZone.classList.add('dragging');};dropZone.ondragleave=()=>dropZone.classList.remove('dragging');dropZone.ondrop=e=>{e.preventDefault();dropZone.classList.remove('dragging');importHandScreenshot([...(e.dataTransfer?.files||[])].find(f=>f.type.startsWith('image/')));};}
    document.querySelectorAll('[data-open-session-hands]').forEach(el=>{const open=()=>{selectedSessionHandsId=el.dataset.openSessionHands;navigate('sessionHands');};el.onclick=e=>{e.stopPropagation();open();};el.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();open();}};});
  document.querySelectorAll('[data-open-library-session]').forEach(el=>{const open=()=>{selectedSessionHandsId=el.dataset.openLibrarySession;navigate('sessionHands');};el.onclick=open;el.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();open();}};});
  document.querySelectorAll('[data-open-hand]').forEach(el=>{const open=()=>{handReturnRoute=route;selectedHandId=el.dataset.openHand;navigate('handDetail');};el.onclick=open;el.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();open();}};});
  document.querySelectorAll('[data-solve-hand]').forEach(el=>el.onclick=()=>{
    const id=el.dataset.solveHand;
    const h=findHandRecord(id);if(!h)return;
    solverReviewHandId=id;selectedHandId=id;
    if(h.solverResult && route==='handDetail'){navigate('solverResult');return;}
    startHandSolve(id);
  });
  document.querySelectorAll('[data-reinspect-solver]').forEach(el=>el.onclick=()=>startHandSolve(el.dataset.reinspectSolver,true));
  const saveSolverSpot=document.querySelector('[data-save-solver-spot]');if(saveSolverSpot)saveSolverSpot.onclick=async()=>{const h=solverHand();collectSolverSpot();h.solverAutoRun=true;await continueHandSolve(h);render();};
  const copySolverDebug=document.querySelector('[data-copy-solver-debug]');if(copySolverDebug)copySolverDebug.onclick=async()=>{
    const h=solverHand();if(!h)return;
    const payload=solverDebugText(h);
    try{await navigator.clipboard.writeText(payload);captureToast('Debug trace copied ✓');}
    catch{captureToast('Could not copy debug trace.','error');}
  };
  document.querySelectorAll('[data-run-solver]').forEach(el=>el.onclick=()=>runSolverForHand(el.dataset.runSolver,{fromEditor:true}));
  document.querySelectorAll('[data-save-hand-notes]').forEach(el=>el.onclick=()=>{const h=findHandRecord(el.dataset.saveHandNotes);if(!h)return;h.notes=(document.getElementById('handNotes')?.value||'').trim();save();const hint=document.getElementById('notesSavedHint');if(hint){hint.textContent='Saved';setTimeout(()=>{if(hint)hint.textContent='';},1600);}captureToast('Note saved ✓');});
  document.querySelectorAll('[data-edit-hand]').forEach(el=>el.onclick=()=>{pendingCapturedHand=findHandRecord(el.dataset.editHand);if(pendingCapturedHand)navigate('captureReview');});
  document.querySelectorAll('[data-delete-hand]').forEach(el=>el.onclick=()=>{removeCapturedHand(el.dataset.deleteHand);selectedHandId=null;navigate(handReturnRoute==='handDetail'?'handsLibrary':handReturnRoute);});
  const saveCapture=document.querySelector('[data-save-capture]');
  if(saveCapture)saveCapture.onclick=()=>{
    if(!pendingCapturedHand)return;
    const editedId=pendingCapturedHand.id;
    const before=JSON.stringify([pendingCapturedHand.heroCards,pendingCapturedHand.board,pendingCapturedHand.position,pendingCapturedHand.pot,pendingCapturedHand.description]);
    document.querySelectorAll('[data-capture-field]').forEach(el=>{
      const key=el.dataset.captureField;
      const value=['heroCards','board'].includes(key)?el.value.trim().split(/\s+/).filter(Boolean):el.value;
      pendingCapturedHand[key]=value;
    });
    const after=JSON.stringify([pendingCapturedHand.heroCards,pendingCapturedHand.board,pendingCapturedHand.position,pendingCapturedHand.pot,pendingCapturedHand.description]);
    if(before!==after)invalidateHandSolver(pendingCapturedHand);
    pendingCapturedHand.title=normalizeCapturedTitle(pendingCapturedHand,pendingCapturedHand.title);
    cancelBackgroundHandJobs(pendingCapturedHand,['Analysis']);
    pendingCapturedHand.userEdited=true;pendingCapturedHand.reviewNeeded=false;pendingCapturedHand.status='ready';
    save();pendingCapturedHand=null;captureToast('Hand updated ✓');selectedHandId=editedId;navigate('handDetail');
  };
  const discardCapture=document.querySelector('[data-discard-capture]'); if(discardCapture)discardCapture.onclick=()=>{if(pendingCapturedHand)removeCapturedHand(pendingCapturedHand.id);pendingCapturedHand=null;navigate(handReturnRoute||'handsLibrary');};
  document.querySelectorAll('[data-retry-hand]').forEach(el=>el.onclick=()=>retryCapturedHand(el.dataset.retryHand));
  document.querySelectorAll('[data-review-hand]').forEach(el=>el.onclick=()=>{pendingCapturedHand=findHandRecord(el.dataset.reviewHand);if(pendingCapturedHand)navigate('captureReview');});
  const exp=document.getElementById('exportData'); if(exp)exp.onclick=()=>{const blob=new Blob([JSON.stringify(state,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='inner-game-data.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),500)};
  const seed=document.getElementById('seedDemo'); if(seed)seed.onclick=()=>{seedDemo();save();navigate('insights');};
  const clear=document.getElementById('clearData'); if(clear)clear.onclick=()=>{if(confirm('Delete all locally stored Inner Game data?')){nativeCall('cancelHandJobs',{all:true});state.activeSession=null;state.sessions=[];state.generalHands=[];syncAutoScreenshotWatcher();cancelBreakReminders();localStorage.removeItem(STORAGE_KEY);LEGACY_STORAGE_KEYS.forEach(k=>localStorage.removeItem(k));location.reload();}};
}
function seedDemo(){ if(state.sessions.length)return; const rows=[[500,820,8,2,2,8,'Calm'],[500,340,5,7,8,4,'Tilted'],[500,620,7,3,4,7,'Focused'],[500,450,6,5,6,6,'Tense'],[500,760,9,2,2,9,'Calm'],[500,540,8,3,3,8,'Focused']]; rows.forEach((r,i)=>state.sessions.push({id:String(Date.now()+i),date:localDateValue(Date.now()-(rows.length-i)*86400000),startAt:Date.now()-(rows.length-i)*86400000-5400000,endAt:Date.now()-(rows.length-i)*86400000,room:i%2?'GG Poker':'Live Casino',game:'NL100',started:r[0],finished:r[1],pnl:r[1]-r[0],process:r[2],judgment:r[3],tilt:r[4],trust:r[5],state:r[6],note:'Demo session',durationMs:5400000})); }

save();
syncAutoScreenshotWatcher();
render();
setTimeout(resumePendingSolverJobs,700);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)resumePendingSolverJobs();});

