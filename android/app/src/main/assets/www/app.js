const STORAGE_KEY = 'innerGame.v5';
const LEGACY_STORAGE_KEYS = ['innerGame.v4','innerGame.v3','innerGame.v2','innerGame.v1'];
const GOALS = ['Stay patient','No results checking','Mark tough spots','Take 3 breaths after big pots','Stick to bankroll','Quit if tilted'];
const defaults = {
  sessions: [],
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
const HAND_ANALYSIS_API_URL = localStorage.getItem('innerGame.handApiUrl') || 'http://localhost:3000';
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
function save(){ localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
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
  ss.forEach(s=>{xp+=100; if((s.process||0)>=8)xp+=50; if((s.tilt||10)<=4)xp+=25; if(s.prep?.handWarmup?.completed)xp+=25;});
  for(let i=ss.length-1;i>=0;i--){ if((ss[i].process||0)>=7)aStreak++; else break; }
  const level=Math.floor(xp/500)+1, inLevel=xp%500;
  const achievements=[
    {icon:'✦',name:'First Session',desc:'Log your first session',on:ss.length>=1},
    {icon:'◈',name:'A-Game',desc:'10 strong-process sessions',on:ss.filter(s=>(s.process||0)>=8).length>=10},
    {icon:'⚡',name:'Volume',desc:'50 total hours',on:ss.reduce((a,s)=>a+(s.durationMs||0),0)>=50*3600000},
    {icon:'↗',name:'Comeback',desc:'Recover after a losing session',on:ss.some((s,i)=>i&&ss[i-1].pnl<0&&s.pnl>0)},
    {icon:'◎',name:'Tilt Proof',desc:'5 sessions with tilt ≤ 3',on:ss.filter(s=>(s.tilt||10)<=3).length>=5},
    {icon:'♠',name:'Warm-up Pro',desc:'Complete 10 hand warm-ups',on:ss.filter(s=>s.prep?.handWarmup?.completed).length>=10}
  ];
  return {xp,level,inLevel,progress:inLevel/500,aStreak,achievements};
}
function avg(a){ return a.length ? a.reduce((x,y)=>x+y,0)/a.length : 0; }
function corr(xs,ys){ if(xs.length<3||xs.length!==ys.length)return null; const mx=avg(xs),my=avg(ys); let n=0,dx=0,dy=0; xs.forEach((x,i)=>{const a=x-mx,b=ys[i]-my;n+=a*b;dx+=a*a;dy+=b*b}); return dx&&dy?n/Math.sqrt(dx*dy):null; }
function navigate(to){ route=to; stopBreath(); stopSessionTicker(); render(); window.scrollTo({top:0,behavior:'instant'}); }
function tabs(active){
  const items=[
    ['home','⌂','Home'],
    ['sessions','◷','Sessions'],
    ['insights','▥','Stats'],
    ['profile','≡','More']
  ];
  const left=items.slice(0,2).map(([r,i,l])=>'<button class="tab '+(active===r?'active':'')+'" data-nav="'+r+'"><span class="ti">'+i+'</span><span>'+l+'</span></button>').join('');
  const right=items.slice(2).map(([r,i,l])=>'<button class="tab '+(active===r?'active':'')+'" data-nav="'+r+'"><span class="ti">'+i+'</span><span>'+l+'</span></button>').join('');
  const center=state.activeSession
    ? '<button class="tab-create stop" data-finish-session aria-label="End session"><span class="stop-square"></span></button>'
    : '<button class="tab-create play" data-start-prep aria-label="Start session"><span class="play-triangle"></span></button>';
  const running=state.activeSession?'<div class="nav-running"><span></span>Session running · <b id="navElapsed">'+formatDuration(Date.now()-state.activeSession.startedAt)+'</b></div>':'';
  return running+'<nav class="tabs apple-tabs">'+left+center+right+'</nav>';
}
function header(title,sub,back=true){ return `<div class="hero"><div class="topbar">${back?'<button class="back" data-back aria-label="Back">‹</button>':''}<div class="hero-copy"><h1>${title}</h1><p class="subtitle">${sub}</p></div></div></div>`; }
function stepper(active){ const labels=['Breathe','Goals','3 Hands','Plan']; return `<div class="stepper four">${labels.map((l,i)=>`<div class="step ${i<active?'done':''} ${i===active?'active':''}"><div class="bubble">${i+1}</div><span>${l}</span></div>`).join('')}</div>`; }
function appShell(content,tab='home'){ return `<main class="app-shell">${content}${tabs(tab)}</main>`; }
function formatDuration(ms){ const total=Math.max(0,Math.floor((Number(ms)||0)/1000)); const h=Math.floor(total/3600), m=Math.floor((total%3600)/60), s=total%60; return h?`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`:`${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`; }
function nativeCall(name,payload={}){
  try{
    if(window.InnerGameNative&&typeof window.InnerGameNative[name]==='function'){ window.InnerGameNative[name](JSON.stringify(payload)); return; }
    if(window.InnerGameDesktop&&name==='captureHand'&&typeof window.InnerGameDesktop.captureHand==='function'){ window.InnerGameDesktop.captureHand(); return; }
    if(window.webkit?.messageHandlers?.innerGame) window.webkit.messageHandlers.innerGame.postMessage({action:name,...payload});
  }catch{}
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
function handDisplayTitle(h){return h.title||[h.stakes,h.site].filter(Boolean).join(' · ')||'Captured hand';}
function handCardsText(h){return [...(h.heroCards||[]),...(h.board||[])].join(' ');}
function captureToast(text,type='ok'){let t=document.getElementById('captureToast');if(!t){t=document.createElement('div');t.id='captureToast';document.body.appendChild(t);}t.className='capture-toast '+type;t.textContent=text;requestAnimationFrame(()=>t.classList.add('show'));setTimeout(()=>t.classList.remove('show'),3000);}
async function analyzeCapturedScreenshot(dataUrl,source='native'){
  if(!state.activeSession){captureToast('Start a session before capturing a hand.','error');return;}
  const compact=await resizeScreenshot(dataUrl);
  captureToast('Analyzing screenshot…');
  try{
    const res=await fetch(HAND_ANALYSIS_API_URL.replace(/\/$/,'')+'/analyze-hand',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({imageDataUrl:compact,context:{sessionGame:state.activeSession.stakes,sessionRoom:state.activeSession.room}})});
    if(!res.ok) throw new Error('analysis');
    const parsed=await res.json();
    if(!parsed.isPokerHand){captureToast('No poker hand detected.','error');return;}
    const id=crypto.randomUUID?.()||String(Date.now());
    pendingCapturedHand={id,source,capturedAt:Date.now(),imageKey:'hand:'+id,...parsed};
    await storeHandImage(pendingCapturedHand.imageKey,compact);
    if((parsed.confidence||0)>=.9 && (!parsed.uncertainFields||parsed.uncertainFields.length===0)){
      saveCapturedHand(pendingCapturedHand); pendingCapturedHand=null; captureToast('Hand saved ✓');
    }else{
      navigate('captureReview');
    }
  }catch(e){
    console.error(e);
    captureToast('Could not analyze screenshot.','error');
  }
}
function saveCapturedHand(hand){
  if(!state.activeSession)return;
  state.activeSession.hands=allSessionHands(state.activeSession);
  state.activeSession.hands.push({...hand,userEdited:false});
  save();
}
window.innerGameReceiveScreenshot=(dataUrl,source='native')=>analyzeCapturedScreenshot(dataUrl,source);
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
  <button class="btn primary" data-save-capture>Save to Session</button>
  <button class="btn ghost" data-discard-capture>Discard</button>`,'sessions');
}
function captureField(label,key,value){return `<div class="field"><label>${label}</label><input type="text" data-capture-field="${key}" value="${esc(value||'')}"></div>`;}
function sessionHands(){
  const target=selectedSessionHandsId==='active'?state.activeSession:state.sessions.find(s=>s.id===selectedSessionHandsId);
  if(!target){route='sessions';return sessions();}
  const hands=allSessionHands(target);
  return appShell(`${header('Session <span class="accent">Hands</span>',`${hands.length} captured hand${hands.length===1?'':'s'}`)}
    <div class="captured-hands-list">${hands.length?hands.map(handCard).join(''):'<div class="notice">No screenshots saved in this session yet.</div>'}</div>`,'sessions');
}
function handCard(h){return `<section class="card captured-hand-card"><img data-hand-image-key="${esc(h.imageKey)}" alt=""><div><strong>${esc(handDisplayTitle(h))}</strong><small>${esc([h.site,h.heroPosition,handCardsText(h)].filter(Boolean).join(' · '))}</small><p>${esc(h.description||h.actionSummary||'')}</p></div></section>`;}
async function hydrateHandImages(){for(const el of document.querySelectorAll('[data-hand-image-key]')){try{const src=await getHandImage(el.dataset.handImageKey);if(src)el.src=src;}catch{}}}
function triggerNativeCapture(){nativeCall('captureHand',{});}

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
  const g=gamificationStats();
  const greeting=(new Date().getHours()<12?'Good morning':new Date().getHours()<18?'Good afternoon':'Good evening');
  const actionPrimary=state.activeSession
    ? '<button class="home-action primary" data-nav="active"><span class="action-symbol play-mini"></span><div><strong>Resume Session</strong><small>Return to live session</small></div></button>'
    : '<button class="home-action primary" data-start-prep><span class="action-symbol play-mini"></span><div><strong>Start Session</strong><small>Prepare, then play</small></div></button>';
  const dots=[0,1,2,3,4,5,6].map((_,i)=>'<span class="'+(i<Math.min(g.aStreak,7)?'done':'')+'"></span>').join('');
  return appShell(
    '<div class="home-top"><button class="home-settings" data-nav="profile" aria-label="Settings">⚙</button><small>'+greeting+',</small><h1>Shay</h1><p>Play focused. Progress compounds.</p></div>'+
    '<div class="stack apple-stack">'+
      '<div class="home-actions">'+
        actionPrimary+
        '<button class="home-action secondary" data-nav="log"><span class="action-symbol">✎</span><div><strong>Log Session</strong><small>Add finished session</small></div></button>'+
      '</div>'+
      homeMoneyCard()+
      '<section class="apple-panel streak-panel compact"><div class="streak-main"><span class="streak-icon">🔥</span><div><strong>'+g.aStreak+'-session A-game streak</strong><div class="streak-dots">'+dots+'</div></div><span class="chev">›</span></div></section>'+
    '</div>',
    'home'
  );
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
function prepRow(icon,title,sub,to,badge=''){ return `<button class="prep-item ${badge?'featured':''}" data-nav="${to}"><span class="icon">${icon}</span><span class="prep-copy"><strong>${title}${badge?` <span class="mini-badge">${badge}</span>`:''}</strong><small>${sub}</small></span><span class="chev">›</span></button>`; }
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
  state.prep.handWarmup={selectedIds:randomThreeHandIds(),answers:{},currentIndex:0,completed:false,skipped:false};
  save(); navigate('prep');
}
function ensureHandWarmup(){
  if(!state.prep.handWarmup || !Array.isArray(state.prep.handWarmup.selectedIds) || state.prep.handWarmup.selectedIds.length!==3){
    state.prep.handWarmup={selectedIds:randomThreeHandIds(),answers:{},currentIndex:0,completed:false,skipped:false}; save();
  }
  return state.prep.handWarmup;
}
function selectedHands(){ const hw=ensureHandWarmup(); return hw.selectedIds.map(id=>HAND_BANK.find(h=>h.id===id)).filter(Boolean); }
function currentHand(){ const hw=ensureHandWarmup(), hs=selectedHands(); return hs[Math.max(0,Math.min(2,hw.currentIndex||0))]; }
function suitSymbol(s){ return ({s:'♠',h:'♥',d:'♦',c:'♣'})[s]||s; }
function cardHTML(card,small=false){ if(!card)return ''; const rank=card[0], suit=card[1], red=suit==='h'||suit==='d'; return `<span class="playing-card ${small?'small':''} ${red?'red':''}"><b>${rank}</b><span>${suitSymbol(suit)}</span></span>`; }
function boardHTML(cards=[]){ return cards.length?`<div class="board-cards">${cards.map(c=>cardHTML(c,true)).join('')}</div>`:`<div class="preflop-label">Preflop — no board yet</div>`; }
function actionIcon(label){ if(/^Call$/i.test(label))return '<span class="poker-chip" aria-hidden="true"><i></i></span>'; if(/Fold/i.test(label))return '<span class="action-x">×</span>'; if(/Check/i.test(label))return '<span class="action-check">✓</span>'; return '<span class="action-up">↑</span>'; }
const TABLE_POSITIONS=['UTG','HJ','CO','BTN','SB','BB'];
function tableSeats(h){
  return TABLE_POSITIONS.map((pos,i)=>{
    const role=pos===h.heroPos?'hero':pos===h.villainPos?'villain':'';
    const tag=role==='hero'?'You':role==='villain'?'Villain':'';
    return `<div class="gg-seat seat-${i+1} ${role}"><span>${pos}</span>${tag?`<small>${tag}</small>`:''}</div>`;
  }).join('');
}
function handProgress(active){ return `<div class="hand-progress">${[0,1,2].map(i=>`<div class="hand-progress-step ${i<active?'done':''} ${i===active?'active':''}"><span>${i+1}</span><small>Hand ${i+1}</small></div>`).join('')}</div>`; }
function handsIntro(){ const hw=ensureHandWarmup(), hs=selectedHands(), done=Object.keys(hw.answers||{}).filter(id=>hw.selectedIds.includes(id)&&hw.answers[id]?.reason).length; return appShell(`${header('Play <span class="accent">3 Hands</span>','Warm up your decision-making before the session.')}
  ${stepper(2)}
  <section class="card pad hand-intro-card"><div class="row between"><strong>${done} of 3 hands completed</strong><span class="session-meta">Randomized from 50</span></div></section>
  <section class="card pad stack"><div><div class="section-title">A quick hand exercise</div><p class="body-copy">Choose your action in three real hold’em spots, then explain the thinking behind it.</p></div><div class="warmup-benefit"><span>↗</span><div><strong>Choose what you would do</strong><small>Make the decision before seeing anything else.</small></div></div><div class="warmup-benefit"><span>✎</span><div><strong>Explain why</strong><small>Put your poker reasoning into words.</small></div></div><div class="warmup-benefit"><span>◎</span><div><strong>Focus on process, not perfection</strong><small>This is a warm-up, not a solver exam.</small></div></div></section>
  <div class="section-title list-heading">Your 3 random hands</div><div class="hand-preview-grid">${hs.map((h,i)=>`<div class="card hand-preview"><strong>Hand ${i+1}</strong><div class="mini-hole">${h.heroHand.map(c=>cardHTML(c,true)).join('')}</div><small>${h.street} · ${h.heroPos}</small></div>`).join('')}</div>
  <div class="notice">There’s no score here. The goal is to switch your brain into deliberate poker decision-making before you play.</div>
  <button class="btn primary" data-start-hands>${done?`Continue Hand ${Math.min(done+1,3)}`:'Start Hand 1'} <span>→</span></button><button class="btn ghost" data-skip-hands>Skip for now</button>`,'home'); }
function handPlay(){ const hw=ensureHandWarmup(), h=currentHand(); if(!h)return handsIntro(); const i=hw.currentIndex||0, a=hw.answers?.[h.id]||{}; return appShell(`${header(`Hand <span class="accent">${i+1} of 3</span>`,`${h.street} spot`)}
  ${handProgress(i)}
  <section class="card pad poker-spot"><div class="section-title">${esc(h.game)} • ${esc(h.effective)} effective</div><div class="session-meta">${esc(h.setup)}</div>
    <div class="gg-table">
      <div class="gg-felt"></div>
      ${tableSeats(h)}
      <div class="gg-center"><div class="gg-pot">Pot <strong>${esc(h.pot)}</strong></div>${boardHTML(h.board)}</div>
      <div class="hero-hand-dock"><small>Your hand · ${esc(h.heroPos)}</small><div class="hole-cards">${h.heroHand.map(c=>cardHTML(c)).join('')}</div></div>
    </div>
    <div class="action-history"><strong>Action History</strong><span>${esc(h.history)}</span></div>
  </section>
  <div class="section-title list-heading">What would you do?</div><div class="action-options">${h.options.map((o,idx)=>`<button class="poker-action ${a.action===o?'selected':''}" data-hand-action="${esc(o)}">${actionIcon(o)}<strong>${esc(o)}</strong></button>`).join('')}</div>
  <section class="card pad"><div class="row between"><div><strong>Confidence</strong><div class="session-meta">How sure are you?</div></div><div class="confidence-row">${[1,2,3,4,5].map(n=>`<button class="confidence ${Number(a.confidence||4)===n?'selected':''}" data-confidence="${n}">${n}</button>`).join('')}</div></div></section>
  <div id="handError" class="form-error" aria-live="polite"></div><button class="btn primary" data-hand-continue>Continue <span>→</span></button>`,'home'); }
function handExplain(){ const hw=ensureHandWarmup(), h=currentHand(); if(!h)return handsIntro(); const i=hw.currentIndex||0, a=hw.answers?.[h.id]||{}; if(!a.action){ route='handPlay'; return handPlay(); } return appShell(`${header('Explain Your <span class="accent">Thinking</span>',`Hand ${i+1} of 3`)}
  <section class="card pad choice-summary"><div class="session-meta">Your choice</div><div class="choice-action">${esc(a.action)}</div><div class="session-meta">${h.heroPos} with ${h.heroHand.map(c=>`${c[0]}${suitSymbol(c[1])}`).join(' ')} · ${h.street}</div></section>
  <section class="card pad"><div class="section-title">Why?</div><div class="session-meta">What makes this the play you want to make?</div><textarea id="handReason" class="reason-box" maxlength="500" placeholder="Explain your ranges, position, board interaction, sizing, pot odds, blockers, exploit, or whatever is driving the decision.">${esc(a.reason||'')}</textarea><div class="reason-prompts"><button data-reason-prompt="Position">+ Position</button><button data-reason-prompt="Ranges">+ Ranges</button><button data-reason-prompt="Pot odds">+ Pot odds</button><button data-reason-prompt="Board texture">+ Board texture</button></div></section>
  <div class="notice">We’re training clear thinking, not perfect solver answers.</div><div id="reasonError" class="form-error" aria-live="polite"></div><button class="btn primary" data-submit-hand>${i===2?'Finish Warm-up':'Submit Hand'} <span>→</span></button>`,'home'); }
function handsComplete(){ const hw=ensureHandWarmup(), hs=selectedHands(); return appShell(`${header('Hand Warm-up <span class="accent">Complete</span>','You completed all 3 hands.')}
  <section class="success-banner"><span>✓</span><div><strong>Nice work.</strong><small>You’ve already started thinking deliberately before the session.</small></div></section>
  <div class="stack">${hs.map((h,i)=>{const a=hw.answers?.[h.id]||{};return `<section class="card hand-result"><div><small>HAND ${i+1} · ${h.street.toUpperCase()}</small><strong>${esc(a.action||'—')}</strong><p>${esc((a.reason||'').slice(0,92))}${(a.reason||'').length>92?'…':''}</p></div><span class="chev">›</span></section>`}).join('')}</div>
  <div class="section-title list-heading">Take one idea into your session</div><div class="notice"><strong>Make the reason explicit.</strong><br>Before a big decision, name the main reason for your action instead of reacting automatically.</div>
  <button class="btn primary" data-nav="review">Continue to Game Plan <span>→</span></button><button class="btn ghost" data-nav="prep">Back to Preparation</button>`,'home'); }

function review(){ ensurePrepSchedule(); const p=state.prep; const hw=p.handWarmup||{}; const warmupText=hw.completed?'3 hands completed':hw.skipped?'Skipped for this session':'Not completed yet'; return appShell(`${header('Session <span class="accent">Setup</span>','Everything you need before you sit down.')}
  ${stepper(3)}
  <section class="card pad"><button class="prep-item nested" data-nav="handsIntro"><span class="icon">${hw.completed?'✓':'♠'}</span><span class="prep-copy"><strong>3-Hand Warm-up</strong><small>${warmupText}</small></span><span class="chev">›</span></button></section>
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
    <section class="card pad active-hands-card"><div class="row between"><div><strong>Session Hands</strong><div class="session-meta">${allSessionHands(a).length} captured</div></div><button class="btn secondary compact" data-capture-hand>Capture Hand</button></div>${allSessionHands(a).length?'<button class="session-hands-link" data-open-active-hands>View saved hands →</button>':''}</section>
    <button class="btn primary" data-finish-session>Finish Session <span>→</span></button>
    <button class="btn ghost" data-nav="home">Back to Home</button>`, 'home');
}
function startSessionTicker(){ stopSessionTicker(); if(route!=='active'||!state.activeSession)return; sessionTicker=setInterval(()=>{ const a=state.activeSession;if(!a)return;const elapsed=Date.now()-a.startedAt;const hourMs=3600000;const toBreak=hourMs-(elapsed%hourMs); const e=document.getElementById('sessionElapsed'),b=document.getElementById('nextBreak'); if(e)e.textContent=formatDuration(elapsed); if(b)b.textContent=formatDuration(toBreak); },1000); }
function stopSessionTicker(){ if(sessionTicker)clearInterval(sessionTicker); sessionTicker=null; }

function logSession(){ const a=state.activeSession; const endNow=Date.now(); const startMs=a?.startedAt ?? endNow-2*3600000; const endMs=endNow; return appShell(`${header('End <span class="accent">Session</span>','Results are data. The review is the work.')}
  <form id="logForm" class="stack">
   <section class="card pad stack"><div class="field"><label>Game / Stakes</label><input name="game" type="text" list="knownGamesLog" data-game-input value="${esc(a?.stakes||state.prep.stakes||'NL100')}" required autocomplete="off"><datalist id="knownGamesLog">${gameOptionsHTML()}</datalist></div><div class="field"><label>Room / Site</label><input name="room" type="text" list="knownRoomsLog" data-room-input value="${esc(a?.room||state.prep.room||'')}" autocomplete="off"><datalist id="knownRoomsLog">${roomOptionsHTML()}</datalist></div><div class="date-time-grid"><div class="field span-2"><label>Started</label><input name="startAt" type="datetime-local" value="${localDateTimeValue(startMs)}" required></div><div class="field span-2"><label>Ended</label><input name="endAt" type="datetime-local" value="${localDateTimeValue(endMs)}" required></div></div><div class="money-grid"><div class="field"><label>Started with ($)</label><input name="started" type="number" min="0" step="1" inputmode="decimal" value="${esc(a?.startedAmount??'')}" required></div><div class="field"><label>Finished with ($)</label><input name="finished" type="number" min="0" step="1" inputmode="decimal" required></div></div></section>
   <section class="card pad"><div class="section-title">Goals review</div><div class="saved-goals">${(a?.prep?.goals||state.prep.goals||[]).filter(Boolean).map(g=>`<div><span>✓</span>${esc(g)}</div>`).join('')||'<div class="session-meta">No goals were set.</div>'}</div></section>
   <section class="card pad"><div class="section-title">Inner Game Review</div>${rangeRow('Process','process',7)}${rangeRow('Self-judgment','judgment',4)}${rangeRow('Tilt','tilt',3)}${rangeRow('Trust','trust',7)}<div class="field top-gap"><label>Non-judgmental observation</label><textarea name="note" placeholder="What happened? What will you repeat or adjust?"></textarea></div></section>
   <button class="btn primary" type="submit">Save Session</button>
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
  return `<section class="card pad progress-card"><div class="row between"><div><small class="eyebrow">PROGRESS</small><div class="section-title compact-title">Level ${g.level}</div></div><div class="xp-badge">${g.xp} XP</div></div><div class="xp-track big"><i style="width:${Math.max(4,g.progress*100)}%"></i></div><div class="row between session-meta"><span>${g.aStreak} session A-game streak</span><span>${unlocked}/${g.achievements.length} badges</span></div><div class="achievement-grid">${g.achievements.map(a=>`<div class="achievement ${a.on?'unlocked':'locked'}"><span>${a.icon}</span><strong>${a.name}</strong><small>${a.desc}</small></div>`).join('')}</div></section>`;
}
function sessions(){
  const list=[...state.sessions].reverse();
  return appShell(`${header('Sessions','Track your play. Find progress.',false)}
  ${moneyGraph()}
  ${gamificationPanel()}
  <section class="card pad"><div class="metrics"><div class="metric"><small>Total Sessions</small><strong>${list.length}</strong></div><div class="metric"><small>Avg Process Score</small><strong>${list.length?avg(list.map(x=>x.process)).toFixed(1):'—'}<span class="session-meta"> / 10</span></strong></div></div></section>
  <div class="section-title list-heading">Recent Sessions</div><section class="card session-list">${list.length?list.map(sessionRow).join(''):'<div class="empty">No sessions yet. Log one after you play.</div>'}</section>
  ${sessionDeleteModal()}`,'sessions');
}
function sessionRow(s){ const when=s.startAt?new Date(s.startAt).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}):s.date; return `<div class="session-row"><div><h3>${esc(s.game)}</h3><div class="session-meta">${esc(when)}${s.room?` · ${esc(s.room)}`:''} · ${esc(s.state)}${s.durationMs?` · ${formatDuration(s.durationMs)}`:''}</div><div class="score">Process ${s.process}/10 · Tilt ${s.tilt}/10</div></div><div class="session-side"><div class="session-pnl ${s.pnl>=0?'positive':'negative'}">${money(s.pnl)}</div><div class="score note-snippet">${esc(s.note||'')}</div></div><div class="session-actions"><button class="session-action" data-edit-session="${esc(s.id)}" aria-label="Edit session">Edit</button><button class="session-action" data-open-session-hands="${esc(s.id)}">Hands ${allSessionHands(s).length}</button><button class="session-action danger-text" data-delete-session="${esc(s.id)}" aria-label="Delete session">Delete</button></div></div>`; }
function editSession(){
  const s=state.sessions.find(x=>x.id===editingSessionId);
  if(!s){editingSessionId=null; route='sessions'; return sessions();}
  const startMs=s.startAt||new Date(`${s.date}T12:00:00`).valueOf(), endMs=s.endAt||((startMs||Date.now())+(s.durationMs||2*3600000));
  return appShell(`${header('Edit <span class="accent">Session</span>','Correct anything that changed.')}
  <form id="editSessionForm" class="stack">
   <section class="card pad stack"><div class="field"><label>Game / Stakes</label><input name="game" type="text" list="knownGamesEdit" data-game-input value="${esc(s.game)}" required autocomplete="off"><datalist id="knownGamesEdit">${gameOptionsHTML()}</datalist></div><div class="field"><label>Room / Site</label><input name="room" type="text" list="knownRoomsEdit" data-room-input value="${esc(s.room||'')}" autocomplete="off"><datalist id="knownRoomsEdit">${roomOptionsHTML()}</datalist></div><div class="field"><label>Started</label><input name="startAt" type="datetime-local" value="${localDateTimeValue(startMs)}" required></div><div class="field"><label>Ended</label><input name="endAt" type="datetime-local" value="${localDateTimeValue(endMs)}" required></div><div class="money-grid"><div class="field"><label>Started with ($)</label><input name="started" type="number" min="0" step="1" value="${esc(s.started)}" required></div><div class="field"><label>Finished with ($)</label><input name="finished" type="number" min="0" step="1" value="${esc(s.finished)}" required></div></div></section>
   <section class="card pad"><div class="section-title">Inner Game Review</div>${rangeRow('Process','edit-process',s.process)}${rangeRow('Self-judgment','edit-judgment',s.judgment)}${rangeRow('Tilt','edit-tilt',s.tilt)}${rangeRow('Trust','edit-trust',s.trust)}<div class="field top-gap"><label>Non-judgmental observation</label><textarea name="note">${esc(s.note||'')}</textarea></div></section>
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

function profile(){ return appShell(`${header('More','Your game, your data, your progress.',false)}<div class="stack">${gamificationPanel()}<section class="card pad"><div class="section-title">Local-first data</div><p class="body-copy">No account and no server are required. Sessions, preparation settings, and insights are stored locally on this phone.</p></section><button class="btn secondary" id="exportData">Export my data</button><button class="btn secondary" id="seedDemo">Add demo sessions</button><button class="btn secondary danger-text" id="clearData">Clear all local data</button></div>`,'profile'); }

function render(){ const app=document.getElementById('app'); app.innerHTML = ({home,prep:prepOverview,breathe,goals,handsIntro,handPlay,handExplain,handsComplete,review,active:activeSession,log:logSession,sessions,editSession,insights,captureReview,sessionHands,profile}[route]||home)(); bind(); hydrateHandImages(); if(route==='active')startSessionTicker(); }
function bind(){
  document.querySelectorAll('[data-nav]').forEach(el=>el.onclick=()=>navigate(el.dataset.nav));
  document.querySelectorAll('[data-back]').forEach(el=>el.onclick=()=>navigate(route==='editSession'?'sessions':route==='log'||route==='active'?'home':route==='breathe'?'prep':route==='goals'?'breathe':route==='handsIntro'?'goals':route==='handPlay'?'handsIntro':route==='handExplain'?'handPlay':route==='handsComplete'?'handsIntro':route==='review'?'handsIntro':'home'));
  const startPrep=document.querySelector('[data-start-prep]'); if(startPrep)startPrep.onclick=beginPreparation;
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
  const startHands=document.querySelector('[data-start-hands]'); if(startHands)startHands.onclick=()=>{ const hw=ensureHandWarmup(); const hs=selectedHands(); let next=hs.findIndex(h=>!hw.answers?.[h.id]?.reason); if(next<0)next=0; hw.currentIndex=next; save(); navigate('handPlay'); };
  const skipHands=document.querySelector('[data-skip-hands]'); if(skipHands)skipHands.onclick=()=>{ const hw=ensureHandWarmup(); hw.skipped=true; hw.completed=false; save(); navigate('review'); };
  document.querySelectorAll('[data-hand-action]').forEach(el=>el.onclick=()=>{ const hw=ensureHandWarmup(),h=currentHand(); hw.answers[h.id]={...(hw.answers[h.id]||{}),action:el.dataset.handAction,confidence:Number(hw.answers[h.id]?.confidence||4)}; save(); render(); });
  document.querySelectorAll('[data-confidence]').forEach(el=>el.onclick=()=>{ const hw=ensureHandWarmup(),h=currentHand(); hw.answers[h.id]={...(hw.answers[h.id]||{}),confidence:Number(el.dataset.confidence)}; save(); render(); });
  const handContinue=document.querySelector('[data-hand-continue]'); if(handContinue)handContinue.onclick=()=>{ const hw=ensureHandWarmup(),h=currentHand(),err=document.getElementById('handError'); if(!hw.answers?.[h.id]?.action){if(err)err.textContent='Choose an action before continuing.';return;} navigate('handExplain'); };
  document.querySelectorAll('[data-reason-prompt]').forEach(el=>el.onclick=()=>{ const t=document.getElementById('handReason'); if(!t)return; const phrase=el.dataset.reasonPrompt; const prefix=t.value.trim()?`${t.value.trim()} · `:''; t.value=prefix+phrase+': '; t.focus(); });
  const submitHand=document.querySelector('[data-submit-hand]'); if(submitHand)submitHand.onclick=()=>{ const hw=ensureHandWarmup(),h=currentHand(),t=document.getElementById('handReason'),reason=(t?.value||'').trim(),err=document.getElementById('reasonError'); if(reason.length<8){if(err)err.textContent='Add a short explanation of why you chose that action.';t?.focus();return;} hw.answers[h.id]={...(hw.answers[h.id]||{}),reason}; if((hw.currentIndex||0)>=2){hw.completed=true;hw.skipped=false;save();navigate('handsComplete');}else{hw.currentIndex=(hw.currentIndex||0)+1;save();navigate('handPlay');} };
  const start=document.querySelector('[data-start-playing]'); if(start)start.onclick=()=>{
    const amount=Number(state.prep.sessionAmount);
    const err=document.getElementById('startError');
    if(!Number.isFinite(amount)||amount<=0){ if(err)err.textContent='Enter the amount you are starting the session with.'; document.querySelector('[data-prep-text="sessionAmount"]')?.focus(); return; }
    ensurePrepSchedule(); rememberGame(state.prep.stakes); rememberRoom(state.prep.room); state.activeSession={startedAt:Date.now(),date:localDateValue(),stakes:normalizeGameName(state.prep.stakes),room:normalizeRoomName(state.prep.room),startedAmount:amount,plannedStart:`${state.prep.startDate}T${state.prep.startTime}`,plannedEnd:`${state.prep.endDate}T${state.prep.endTime}`,prep:structuredClone(state.prep),hands:[]};
    save(); scheduleBreakReminders(); navigate('active');
  };
  const finish=document.querySelector('[data-finish-session]'); if(finish)finish.onclick=()=>navigate('log');
  const f=document.getElementById('logForm'); if(f)f.onsubmit=e=>{
    e.preventDefault(); const fd=new FormData(f), started=Number(fd.get('started')),finished=Number(fd.get('finished'));
    const process=Number(document.querySelector('[data-range="process"]')?.value||7), judgment=Number(document.querySelector('[data-range="judgment"]')?.value||4), tilt=Number(document.querySelector('[data-range="tilt"]')?.value||3), trust=Number(document.querySelector('[data-range="trust"]')?.value||7);
    const mental=state.activeSession?.prep; const scoreState = tilt>=8?'Tilted':(mental?.noise??5)<=3&&tilt<=4?'Calm':trust>=7?'Focused':'Tense';
    const durationMs=state.activeSession?Date.now()-state.activeSession.startedAt:null;
    const startAt=parseLocalDateTime(fd.get('startAt')), endAt=parseLocalDateTime(fd.get('endAt')); if(!startAt||!endAt||endAt<startAt)return;
    const room=normalizeRoomName(fd.get('room')); rememberGame(fd.get('game')); rememberRoom(room); state.sessions.push({id:crypto.randomUUID?.()||String(Date.now()),date:localDateValue(startAt),startAt,endAt,room,game:normalizeGameName(fd.get('game')),started,finished,pnl:finished-started,process,judgment,tilt,trust,state:scoreState,note:fd.get('note'),prep:mental||null,durationMs:endAt-startAt,hands:allSessionHands(state.activeSession)});
    state.activeSession=null; save(); cancelBreakReminders(); navigate('sessions');
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
    const startAt=parseLocalDateTime(fd.get('startAt')), endAt=parseLocalDateTime(fd.get('endAt')); if(!startAt||!endAt||endAt<startAt)return; const room=normalizeRoomName(fd.get('room')); rememberGame(fd.get('game')); rememberRoom(room); Object.assign(item,{date:localDateValue(startAt),startAt,endAt,durationMs:endAt-startAt,room,game:normalizeGameName(fd.get('game')),started,finished,pnl:finished-started,process,judgment,tilt,trust,note:fd.get('note')}); item.state=tilt>=8?'Tilted':(item.prep?.noise??5)<=3&&tilt<=4?'Calm':trust>=7?'Focused':'Tense'; save(); editingSessionId=null; navigate('sessions');
  };
  document.querySelectorAll('[data-money-range]').forEach(el=>el.onclick=()=>{moneyRange=el.dataset.moneyRange;render();});
  const moneyGameFilter=document.getElementById('moneyGameFilter'); if(moneyGameFilter)moneyGameFilter.onchange=()=>{moneyGame=moneyGameFilter.value;render();};
  document.querySelectorAll('[data-money-point]').forEach(el=>{ el.onpointerenter=()=>showMoneyPoint(el.dataset.moneyPoint); el.onclick=()=>showMoneyPoint(el.dataset.moneyPoint); });
  const captureBtn=document.querySelector('[data-capture-hand]'); if(captureBtn)captureBtn.onclick=triggerNativeCapture;
  const openActiveHands=document.querySelector('[data-open-active-hands]'); if(openActiveHands)openActiveHands.onclick=()=>{selectedSessionHandsId='active';navigate('sessionHands');};
  document.querySelectorAll('[data-open-session-hands]').forEach(el=>el.onclick=()=>{selectedSessionHandsId=el.dataset.openSessionHands;navigate('sessionHands');});
  const saveCapture=document.querySelector('[data-save-capture]'); if(saveCapture)saveCapture.onclick=()=>{ if(!pendingCapturedHand)return; document.querySelectorAll('[data-capture-field]').forEach(el=>{const k=el.dataset.captureField;let v=el.value;if(k==='heroCards'||k==='board')v=v.trim().split(/\s+/).filter(Boolean);pendingCapturedHand[k]=v;}); pendingCapturedHand.userEdited=true; saveCapturedHand(pendingCapturedHand); pendingCapturedHand=null; captureToast('Hand saved ✓'); navigate('active'); };
  const discardCapture=document.querySelector('[data-discard-capture]'); if(discardCapture)discardCapture.onclick=()=>{pendingCapturedHand=null;navigate('active');};
  const exp=document.getElementById('exportData'); if(exp)exp.onclick=()=>{const blob=new Blob([JSON.stringify(state,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='inner-game-data.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),500)};
  const seed=document.getElementById('seedDemo'); if(seed)seed.onclick=()=>{seedDemo();save();navigate('insights');};
  const clear=document.getElementById('clearData'); if(clear)clear.onclick=()=>{if(confirm('Delete all locally stored Inner Game data?')){cancelBreakReminders();localStorage.removeItem(STORAGE_KEY);LEGACY_STORAGE_KEYS.forEach(k=>localStorage.removeItem(k));location.reload();}};
}
function seedDemo(){ if(state.sessions.length)return; const rows=[[500,820,8,2,2,8,'Calm'],[500,340,5,7,8,4,'Tilted'],[500,620,7,3,4,7,'Focused'],[500,450,6,5,6,6,'Tense'],[500,760,9,2,2,9,'Calm'],[500,540,8,3,3,8,'Focused']]; rows.forEach((r,i)=>state.sessions.push({id:String(Date.now()+i),date:localDateValue(Date.now()-(rows.length-i)*86400000),startAt:Date.now()-(rows.length-i)*86400000-5400000,endAt:Date.now()-(rows.length-i)*86400000,room:i%2?'GG Poker':'Live Casino',game:'NL100',started:r[0],finished:r[1],pnl:r[1]-r[0],process:r[2],judgment:r[3],tilt:r[4],trust:r[5],state:r[6],note:'Demo session',durationMs:5400000})); }

save();
render();