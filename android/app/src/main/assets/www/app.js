const STORAGE_KEY = 'innerGame.v5';
const LEGACY_STORAGE_KEYS = ['innerGame.v4','innerGame.v3','innerGame.v2','innerGame.v1'];
const defaults = {
  sessions: [],
  games:['NL100'],
  prep: {
    breathLevel:'beginner', breathWorkout:'focus', goals:['Stay patient','Mark tough spots',''], energy:6, focus:7, noise:3,
    environment:{silent:true, distractions:true, water:true}, leak:'', reminder:'', stakes:'NL100', room:'',
    stopLoss:'3 buy-ins', length:'90 min', sessionAmount:'',
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
let moneyRange = 'all';
let moneyGame = 'all';
let moneyMode = 'bankroll';
let selectedMoneyPoint = null;
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
function avg(a){ return a.length ? a.reduce((x,y)=>x+y,0)/a.length : 0; }
function corr(xs,ys){ if(xs.length<3||xs.length!==ys.length)return null; const mx=avg(xs),my=avg(ys); let n=0,dx=0,dy=0; xs.forEach((x,i)=>{const a=x-mx,b=ys[i]-my;n+=a*b;dx+=a*a;dy+=b*b}); return dx&&dy?n/Math.sqrt(dx*dy):null; }

function toLocalParts(value=Date.now()){
  const d=value instanceof Date?value:new Date(value);
  const safe=Number.isNaN(d.valueOf())?new Date():d;
  const pad=n=>String(n).padStart(2,'0');
  return {
    date:`${safe.getFullYear()}-${pad(safe.getMonth()+1)}-${pad(safe.getDate())}`,
    time:`${pad(safe.getHours())}:${pad(safe.getMinutes())}`
  };
}
function localDateTime(date,time){
  if(!date)return null;
  const d=new Date(`${date}T${time||'00:00'}`);
  return Number.isNaN(d.valueOf())?null:d.getTime();
}
function formatSessionClock(ts){
  if(!ts)return '—';
  const d=new Date(ts);
  return Number.isNaN(d.valueOf())?'—':d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
}
function formatSessionDate(ts,fallback=''){
  if(!ts)return fallback||'—';
  const d=new Date(ts);
  return Number.isNaN(d.valueOf())?(fallback||'—'):d.toLocaleDateString([], {month:'short',day:'numeric',year:'numeric'});
}
function knownRooms(){
  const rows=[
    ...(state.sessions||[]).map(s=>String(s.room||'').trim()),
    String(state.prep?.room||'').trim()
  ].filter(Boolean);
  return [...new Set(rows)].sort((a,b)=>a.localeCompare(b));
}
function dayPart(){
  const h=new Date().getHours();
  return h<12?'morning':h<18?'afternoon':'evening';
}
function gameStats(){
  const ss=state.sessions||[];
  const totalHours=ss.reduce((a,s)=>a+(Number(s.durationMs)||0),0)/3600000;
  const strong=ss.filter(s=>(Number(s.process)||0)>=8).length;
  const calm=ss.filter(s=>(Number(s.tilt)||0)<=4).length;
  const wins=ss.filter(s=>(Number(s.pnl)||0)>0).length;
  const xp=ss.length*90 + strong*35 + calm*15 + Math.round(totalHours*3);
  const level=Math.max(1,Math.floor(xp/500)+1);
  const into=xp%500;
  const dates=[...new Set(ss.map(s=>s.startDate||s.date).filter(Boolean))].sort();
  let streak=dates.length?1:0;
  for(let i=dates.length-1;i>0;i--){
    const a=new Date(`${dates[i]}T00:00:00`), b=new Date(`${dates[i-1]}T00:00:00`);
    if(Math.round((a-b)/86400000)===1)streak++; else break;
  }
  const achievements=[
    {icon:'✦',title:'First Log',sub:'Log your first session',unlocked:ss.length>=1},
    {icon:'◇',title:'A-Game',sub:'5 sessions at 8+ process',unlocked:strong>=5},
    {icon:'◉',title:'Tilt Proof',sub:'5 low-tilt sessions',unlocked:calm>=5},
    {icon:'⚡',title:'Volume',sub:'50 hours tracked',unlocked:totalHours>=50},
    {icon:'↗',title:'Momentum',sub:'3 winning sessions',unlocked:wins>=3},
    {icon:'◎',title:'Level 5',sub:'Reach level five',unlocked:level>=5}
  ];
  return {xp,level,into,progress:Math.min(100,into/500*100),streak,totalHours,strong,calm,wins,achievements};
}
function xpPanel(compact=false){
  const g=gameStats(), unlocked=g.achievements.filter(a=>a.unlocked).length;
  return `<section class="card xp-card ${compact?'compact-xp':''}">
    <div class="xp-top"><div class="xp-orb">✦</div><div class="xp-copy"><small>INNER GAME LEVEL</small><strong>Level ${g.level}</strong><span>${g.xp.toLocaleString()} XP · ${unlocked}/${g.achievements.length} badges</span></div><div class="streak-pill">🔥 ${g.streak}</div></div>
    <div class="xp-track"><i style="width:${g.progress}%"></i></div>
    <div class="xp-caption"><span>${g.into} / 500 XP</span><span>Next level</span></div>
  </section>`;
}
function achievementPanel(){
  const g=gameStats();
  return `<section class="card pad achievement-section"><div class="row between section-head"><div><div class="section-title">Achievements</div><div class="session-meta">Progress without turning poker into a slot machine.</div></div><span class="achievement-count">${g.achievements.filter(a=>a.unlocked).length}/${g.achievements.length}</span></div>
  <div class="achievement-grid">${g.achievements.map(a=>`<div class="achievement ${a.unlocked?'unlocked':'locked'}"><span>${a.icon}</span><strong>${a.title}</strong><small>${a.sub}</small></div>`).join('')}</div></section>`;
}
function navigate(to){ route=to; stopBreath(); stopSessionTicker(); render(); window.scrollTo({top:0,behavior:'instant'}); }
function tabs(active){ return `<nav class="tabs">${[['home','⌂','Home'],['sessions','▤','Sessions'],['insights','▦','Stats'],['profile','•••','More']].map(([r,i,l])=>`<button class="tab ${active===r?'active':''}" data-nav="${r}"><span class="ti">${i}</span><span>${l}</span></button>`).join('')}</nav>`; }
function header(title,sub,back=true){ return `<div class="hero"><div class="topbar">${back?'<button class="back" data-back aria-label="Back">‹</button>':''}<div class="hero-copy"><h1>${title}</h1><p class="subtitle">${sub}</p></div></div></div>`; }
function stepper(active){ const labels=['Breathe','Goals','3 Hands','Plan']; return `<div class="stepper four">${labels.map((l,i)=>`<div class="step ${i<active?'done':''} ${i===active?'active':''}"><div class="bubble">${i+1}</div><span>${l}</span></div>`).join('')}</div>`; }
function appShell(content,tab='home'){ return `<main class="app-shell">${content}${tabs(tab)}</main>`; }
function formatDuration(ms){ const total=Math.max(0,Math.floor(ms/1000)); const h=Math.floor(total/3600), m=Math.floor((total%3600)/60), s=total%60; return h?`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`:`${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`; }
function nativeCall(name, payload={}){
  try {
    if (window.InnerGameNative && typeof window.InnerGameNative[name] === 'function') { window.InnerGameNative[name](JSON.stringify(payload)); return; }
    if (window.webkit?.messageHandlers?.innerGame) window.webkit.messageHandlers.innerGame.postMessage({action:name,...payload});
  } catch {}
}
function scheduleBreakReminders(){ if(!state.activeSession)return; nativeCall('scheduleBreakReminders',{startedAt:state.activeSession.startedAt, intervalMinutes:60, breakMinutes:5}); }
function cancelBreakReminders(){ nativeCall('cancelBreakReminders'); }

function home(){
  const s=state.sessions, pnl=s.reduce((a,x)=>a+(Number(x.pnl)||0),0), ps=avg(s.map(x=>Number(x.process)||0)), g=gameStats();
  const last=s.at(-1), goal=(state.prep.goals||[]).find(x=>String(x).trim())||'Play the process, not the result';
  const monthSessions=s.filter(x=>{const d=new Date(`${x.startDate||x.date}T00:00:00`),n=new Date();return !Number.isNaN(d.valueOf())&&d.getMonth()===n.getMonth()&&d.getFullYear()===n.getFullYear();});
  const monthPnl=monthSessions.reduce((a,x)=>a+(Number(x.pnl)||0),0);
  return appShell(`
    <div class="apple-home-head"><div><small>Good ${dayPart()},</small><h1>Inner Game</h1><p>Play clearer. Improve faster.</p></div><img class="app-mark" src="app-icon.svg" alt="Inner Game"></div>
    <div class="stack">
      <section class="card hero-money-card">
        <div class="row between"><div><small>This month</small><strong class="${monthPnl>=0?'positive':'negative'}">${money(monthPnl)}</strong></div><button class="round-link" data-nav="sessions">›</button></div>
        <div class="home-sparkline">${miniSparkline(monthSessions)}</div>
        <div class="home-metrics"><span><b>${monthSessions.length}</b><small>Sessions</small></span><span><b>${g.totalHours.toFixed(1)}h</b><small>Tracked</small></span><span><b>${ps?ps.toFixed(1):'—'}</b><small>Process</small></span></div>
      </section>
      ${xpPanel(true)}
      <section class="card focus-card"><div class="focus-icon">◎</div><div><small>TODAY'S FOCUS</small><strong>${esc(goal)}</strong></div><span class="chev">›</span></section>
      ${state.activeSession?`<button class="action-card apple-action primary" data-nav="active"><span class="icon">◷</span><span><div class="action-title">Session in progress</div><div class="action-sub">${esc(state.activeSession.stakes)}${state.activeSession.room?` · ${esc(state.activeSession.room)}`:''}</div></span><span class="chev">›</span></button>`:`<button class="action-card apple-action primary" data-start-prep><span class="icon">＋</span><span><div class="action-title">Start a session</div><div class="action-sub">Prepare, play, review</div></span><span class="chev">›</span></button>`}
      <button class="action-card apple-action" data-nav="log"><span class="icon">✎</span><span><div class="action-title">Log past session</div><div class="action-sub">Add room, time, result and review</div></span><span class="chev">›</span></button>
      ${last?`<section class="card recent-strip"><small>LAST SESSION</small><div class="row between"><div><strong>${esc(last.game)}${last.room?` · ${esc(last.room)}`:''}</strong><span>${formatSessionDate(last.startedAt,last.date)} · Process ${last.process}/10</span></div><b class="${last.pnl>=0?'positive':'negative'}">${money(last.pnl)}</b></div></section>`:''}
    </div>`, 'home');
}
function miniSparkline(rows){
  const vals=[];let t=0;(rows||[]).forEach(s=>{t+=Number(s.pnl)||0;vals.push(t)});
  if(vals.length<2)return `<div class="spark-empty">Your monthly curve will appear here.</div>`;
  const min=Math.min(...vals,0),max=Math.max(...vals,0),span=Math.max(1,max-min),W=320,H=72,P=4;
  const pts=vals.map((v,i)=>[P+(i/(vals.length-1))*(W-P*2),P+((max-v)/span)*(H-P*2)]);
  const d=pts.map((p,i)=>`${i?'L':'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><path d="${d}"/></svg>`;
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

function goals(){
  const p=state.prep;
  while(p.goals.length<3)p.goals.push('');
  const count=p.goals.filter(g=>String(g).trim()).length;
  return appShell(`${header('Goals & <span class="accent">Readiness</span>','Write the process you actually want to follow.')}
  ${stepper(1)}
  <section class="card pad"><div class="row between section-head"><div><div class="section-title">Your process goals</div><div class="session-meta">Free text. Keep them observable and specific.</div></div><strong class="accent-text" id="goalCount">${count}/3</strong></div>
  <div class="free-goals">${p.goals.slice(0,3).map((g,i)=>`<div class="goal-input-row"><span>${i+1}</span><input type="text" maxlength="120" data-goal-input="${i}" value="${esc(g)}" placeholder="${['e.g. Take 3 breaths after big pots','e.g. No results checking while playing','e.g. Mark tough river spots for review'][i]}"></div>`).join('')}</div>
  <div class="goal-tip">Good goal = something you can do, not something you need to win.</div></section>
  <section class="card pad"><div class="section-title">Readiness</div>${rangeRow('Energy','energy',p.energy)}${rangeRow('Focus','focus',p.focus)}${rangeRow('Mental Noise','noise',p.noise)}</section>
  <section class="card pad"><div class="section-title">Environment</div><div class="goal-grid">${envChip('silent','Phone on silent',p.environment.silent)}${envChip('distractions','No distractions',p.environment.distractions)}${envChip('water','Water ready',p.environment.water)}</div></section>
  <button class="btn primary" data-nav="handsIntro">Continue <span>→</span></button>`,'home');
}
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

function review(){
  const p=state.prep; const hw=p.handWarmup||{}; const warmupText=hw.completed?'3 hands completed':hw.skipped?'Skipped for this session':'Not completed yet';
  return appShell(`${header('Review & <span class="accent">Plan</span>','Set the table context before you start.')}
  ${stepper(3)}
  <section class="card pad"><button class="prep-item nested" data-nav="handsIntro"><span class="icon">${hw.completed?'✓':'♠'}</span><span class="prep-copy"><strong>3-Hand Warm-up</strong><small>${warmupText}</small></span><span class="chev">›</span></button></section>
  <section class="card pad stack"><div class="field"><label>One leak to watch today</label><input type="text" data-prep-text="leak" value="${esc(p.leak)}" placeholder="e.g. Calling too wide vs. 3-bets in position"></div><div class="field"><label>One reminder for this session</label><input type="text" data-prep-text="reminder" value="${esc(p.reminder)}" placeholder="e.g. Stay calm and stick to my process"></div></section>
  <section class="card pad"><div class="section-title">Session Setup</div><div class="stack">
    ${gameField('Game / Stakes','stakes',p.stakes)}
    <div class="field"><label>Room / Location</label><input type="text" list="knownRooms" data-prep-text="room" value="${esc(p.room||'')}" placeholder="GG Poker, Bellagio, home game…" autocomplete="off"><datalist id="knownRooms">${knownRooms().map(r=>`<option value="${esc(r)}"></option>`).join('')}</datalist></div>
    ${simpleField('Session amount ($)','sessionAmount',p.sessionAmount,'number','Amount you are starting the session with')}
    ${simpleField('Stop-loss','stopLoss',p.stopLoss,'text')}
    ${simpleField('Target session length','length',p.length,'text')}
  </div></section>
  <div class="notice"><strong>Hourly reset</strong><br>Once you start, the app will remind you every hour to stop for a 5-minute refresh.</div>
  <div id="startError" class="form-error" aria-live="polite"></div>
  <button class="btn primary" data-start-playing>Start Playing <span>→</span></button>`,'home');
}
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
  const goals=(a.prep?.goals||[]).filter(Boolean).slice(0,3);
  return appShell(`${header('Live Session','Stay with the process. The clock handles the rest.',false)}
    <section class="active-clock-card card pad">
      <div class="live-pill"><span class="live-dot"></span> RUNNING</div>
      <div class="session-clock" id="sessionElapsed">${formatDuration(elapsed)}</div>
      <div class="clock-caption">${esc(a.stakes)}${a.room?` · ${esc(a.room)}`:''}</div>
      <div class="break-ring"><div><small>Next 5-min reset</small><strong id="nextBreak">${formatDuration(toBreak)}</strong></div></div>
    </section>
    <section class="card pad session-summary">
      <div class="summary-row"><span>Started</span><strong>${formatSessionDate(a.startedAt)} · ${formatSessionClock(a.startedAt)}</strong></div>
      <div class="summary-row"><span>Started with</span><strong>${money(a.startedAmount)}</strong></div>
      ${a.room?`<div class="summary-row"><span>Room</span><strong>${esc(a.room)}</strong></div>`:''}
    </section>
    ${goals.length?`<section class="card pad"><div class="section-title">Your goals</div><div class="live-goals">${goals.map(g=>`<div><span>✓</span><p>${esc(g)}</p></div>`).join('')}</div></section>`:''}
    <div class="notice"><strong>Reset #${nextBreakNumber}</strong><br>When the reminder hits: stand up, hydrate, look away from the tables, and take the full five minutes.</div>
    <button class="btn primary" data-finish-session>End Session <span>→</span></button>
    <button class="btn ghost" data-nav="home">Back to Home</button>`, 'home');
}
function startSessionTicker(){ stopSessionTicker(); if(route!=='active'||!state.activeSession)return; sessionTicker=setInterval(()=>{ const a=state.activeSession;if(!a)return;const elapsed=Date.now()-a.startedAt;const hourMs=3600000;const toBreak=hourMs-(elapsed%hourMs); const e=document.getElementById('sessionElapsed'),b=document.getElementById('nextBreak'); if(e)e.textContent=formatDuration(elapsed); if(b)b.textContent=formatDuration(toBreak); },1000); }
function stopSessionTicker(){ if(sessionTicker)clearInterval(sessionTicker); sessionTicker=null; }

function logSession(){
  const a=state.activeSession, now=Date.now(), start=toLocalParts(a?.startedAt||now), end=toLocalParts(now), startedPrefill=a?.startedAmount ?? '';
  return appShell(`${header('End <span class="accent">Session</span>','Close the loop while the session is fresh.')}
  <form id="logForm" class="stack">
   <section class="card pad stack">
    <div class="field"><label>Game / Stakes</label><input name="game" type="text" list="knownGamesLog" data-game-input value="${esc(a?.stakes||state.prep.stakes||'NL100')}" required autocomplete="off"><datalist id="knownGamesLog">${gameOptionsHTML()}</datalist></div>
    <div class="field"><label>Room / Location</label><input name="room" type="text" list="knownRoomsLog" value="${esc(a?.room||state.prep.room||'')}" placeholder="GG Poker, casino, home game…"><datalist id="knownRoomsLog">${knownRooms().map(r=>`<option value="${esc(r)}"></option>`).join('')}</datalist></div>
    <div class="date-time-card"><div><small>START</small><div class="date-time-grid"><input name="startDate" type="date" value="${start.date}" required><input name="startTime" type="time" value="${start.time}" required></div></div><div><small>END</small><div class="date-time-grid"><input name="endDate" type="date" value="${end.date}" required><input name="endTime" type="time" value="${end.time}" required></div></div></div>
    <div class="money-grid"><div class="field"><label>Started with ($)</label><input name="started" type="number" min="0" step="1" inputmode="decimal" value="${esc(startedPrefill)}" required></div><div class="field"><label>Finished with ($)</label><input name="finished" type="number" min="0" step="1" inputmode="decimal" required></div></div>
   </section>
   <section class="card pad"><div class="section-title">Inner Game Review</div>${rangeRow('Process','process',7)}${rangeRow('Self-judgment','judgment',4)}${rangeRow('Tilt','tilt',3)}${rangeRow('Trust','trust',7)}<div class="field top-gap"><label>Non-judgmental observation</label><textarea name="note" placeholder="Describe what happened, not what it says about you."></textarea></div></section>
   <button class="btn primary" type="submit">Save Session</button>
  </form>`,'sessions');
}
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
  const rows=filterMoneySessions();
  let running=0;
  const data=rows.map(s=>{
    running+=Number(s.pnl)||0;
    const hours=Math.max((Number(s.durationMs)||0)/3600000,.01);
    return {session:s,bankroll:running,sessionPnl:Number(s.pnl)||0,hourly:(Number(s.pnl)||0)/hours};
  });
  const key=moneyMode==='session'?'sessionPnl':moneyMode==='hourly'?'hourly':'bankroll';
  const unit=moneyMode==='hourly'?'/hr':'';
  const values=data.map(d=>d[key]);
  const total=data.at(-1)?.bankroll||0;
  const min=Math.min(...values,0), max=Math.max(...values,0), span=Math.max(1,max-min);
  const W=340,H=190,PX=18,PY=18;
  const points=data.map((d,i)=>[PX+(i/(Math.max(1,data.length-1)))*(W-PX*2),PY+((max-d[key])/span)*(H-PY*2)]);
  const path=points.map((p,i)=>`${i?'L':'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const zeroY=PY+((max-0)/span)*(H-PY*2);
  const selected=data.length?Math.max(0,Math.min(data.length-1,selectedMoneyPoint??data.length-1)):null;
  const sel=selected!==null?data[selected]:null, selPt=selected!==null?points[selected]:null;
  const wins=rows.filter(s=>(Number(s.pnl)||0)>0).length;
  const best=rows.length?rows.reduce((a,b)=>(Number(b.pnl)||0)>(Number(a.pnl)||0)?b:a,rows[0]):null;
  return `<section class="card pad bankroll-card">
    <div class="row between section-head"><div><div class="section-title">Money</div><div class="session-meta">Touch any point to inspect a session.</div></div><strong class="${total>=0?'positive':'negative'}">${money(total)}</strong></div>
    <div class="money-filters"><div class="range-pills">${[['7','7D'],['30','30D'],['90','3M'],['all','All']].map(([v,l])=>`<button class="${moneyRange===v?'active':''}" data-money-range="${v}">${l}</button>`).join('')}</div>
    <select id="moneyGameFilter" aria-label="Filter graph by game"><option value="all">All games</option>${knownGames().map(g=>`<option value="${esc(g)}" ${moneyGame===g?'selected':''}>${esc(g)}</option>`).join('')}</select></div>
    <div class="money-mode segmented">${[['bankroll','Bankroll'],['session','Session'],['hourly','Hourly']].map(([v,l])=>`<button class="${moneyMode===v?'active':''}" data-money-mode="${v}">${l}</button>`).join('')}</div>
    <div class="money-chart-wrap interactive">${rows.length?`<svg class="money-chart" id="moneyChart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Interactive money graph">
      <defs><linearGradient id="moneyFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#3be6a4" stop-opacity=".28"/><stop offset="100%" stop-color="#3be6a4" stop-opacity="0"/></linearGradient></defs>
      <line class="money-zero" x1="${PX}" y1="${zeroY}" x2="${W-PX}" y2="${zeroY}"/>
      ${points.length>1?`<path class="money-area" d="${path} L ${points.at(-1)[0]},${zeroY} L ${points[0][0]},${zeroY} Z"/><path class="money-line" d="${path}"/>`:''}
      ${points.map(([x,y],i)=>`<circle class="${i===selected?'selected':''}" data-money-point="${i}" cx="${x}" cy="${y}" r="${i===selected?6:4}" tabindex="0"/>`).join('')}
    </svg>
    ${sel&&selPt?`<div class="money-tooltip" style="--x:${(selPt[0]/W*100).toFixed(1)}%;--y:${(selPt[1]/H*100).toFixed(1)}%"><small>${esc(sel.session.startDate||sel.session.date)} · ${esc(sel.session.game)}</small><strong class="${sel.sessionPnl>=0?'positive':'negative'}">${money(sel.sessionPnl)}</strong><span>${moneyMode==='hourly'?`${money(sel.hourly)}/hr`:moneyMode==='bankroll'?`Bankroll ${money(sel.bankroll)}`:`${sel.session.room?esc(sel.session.room)+' · ':''}Process ${sel.session.process}/10`}</span></div>`:''}`:`<div class="empty graph-empty">No sessions match these filters.</div>`}</div>
    <div class="money-fun-stats"><div><small>Win sessions</small><strong>${rows.length?Math.round(wins/rows.length*100):0}%</strong></div><div><small>Best session</small><strong class="positive">${best?money(best.pnl):'—'}</strong></div><div><small>Tracked</small><strong>${rows.length}</strong></div></div>
  </section>`;
}
function sessionDeleteModal(){
  if(!pendingDeleteSessionId)return '';
  const item=state.sessions.find(x=>x.id===pendingDeleteSessionId);
  if(!item){pendingDeleteSessionId=null;return '';}
  return `<div class="modal-backdrop" role="presentation"><section class="confirm-sheet" role="dialog" aria-modal="true" aria-labelledby="deleteTitle"><div class="danger-icon">×</div><h2 id="deleteTitle">Delete this session?</h2><p>${esc(item.game)} · ${esc(item.date)} · ${money(item.pnl)}<br>This cannot be undone.</p><div class="confirm-actions"><button class="btn secondary" type="button" data-cancel-delete>Keep Session</button><button class="btn danger" type="button" data-confirm-delete>Delete Session</button></div></section></div>`;
}
function sessions(){
  const list=[...state.sessions].reverse();
  return appShell(`${header('Sessions','Track your play. Find progress.',false)}
  ${moneyGraph()}
  <section class="card pad"><div class="metrics"><div class="metric"><small>Total Sessions</small><strong>${list.length}</strong></div><div class="metric"><small>Avg Process Score</small><strong>${list.length?avg(list.map(x=>x.process)).toFixed(1):'—'}<span class="session-meta"> / 10</span></strong></div></div></section>
  <div class="section-title list-heading">Recent Sessions</div><section class="card session-list">${list.length?list.map(sessionRow).join(''):'<div class="empty">No sessions yet. Log one after you play.</div>'}</section>
  ${sessionDeleteModal()}`,'sessions');
}
function sessionRow(s){
  const start=s.startedAt||localDateTime(s.startDate||s.date,s.startTime), end=s.endedAt||localDateTime(s.endDate||s.date,s.endTime);
  return `<div class="session-row"><div><h3>${esc(s.game)}${s.room?` <span class="room-dot">·</span> ${esc(s.room)}`:''}</h3><div class="session-meta">${formatSessionDate(start,s.date)} · ${formatSessionClock(start)}${end?`–${formatSessionClock(end)}`:''}${s.durationMs?` · ${formatDuration(s.durationMs)}`:''}</div><div class="score">Process ${s.process}/10 · Tilt ${s.tilt}/10</div></div><div class="session-side"><div class="session-pnl ${s.pnl>=0?'positive':'negative'}">${money(s.pnl)}</div><div class="score note-snippet">${esc(s.note||'')}</div></div><div class="session-actions"><button class="session-action" data-edit-session="${esc(s.id)}" aria-label="Edit session">Edit</button><button class="session-action danger-text" data-delete-session="${esc(s.id)}" aria-label="Delete session">Delete</button></div></div>`;
}
function editSession(){
  const s=state.sessions.find(x=>x.id===editingSessionId);
  if(!s){editingSessionId=null; route='sessions'; return sessions();}
  const start=toLocalParts(s.startedAt||localDateTime(s.startDate||s.date,s.startTime)||Date.now());
  const end=toLocalParts(s.endedAt||localDateTime(s.endDate||s.date,s.endTime)||(s.startedAt+(s.durationMs||0))||Date.now());
  return appShell(`${header('Edit <span class="accent">Session</span>','Correct the record without losing the review.')}
  <form id="editSessionForm" class="stack">
   <section class="card pad stack">
    <div class="field"><label>Game / Stakes</label><input name="game" type="text" list="knownGamesEdit" data-game-input value="${esc(s.game)}" required autocomplete="off"><datalist id="knownGamesEdit">${gameOptionsHTML()}</datalist></div>
    <div class="field"><label>Room / Location</label><input name="room" type="text" value="${esc(s.room||'')}" placeholder="Room or site"></div>
    <div class="date-time-card"><div><small>START</small><div class="date-time-grid"><input name="startDate" type="date" value="${start.date}" required><input name="startTime" type="time" value="${start.time}" required></div></div><div><small>END</small><div class="date-time-grid"><input name="endDate" type="date" value="${end.date}" required><input name="endTime" type="time" value="${end.time}" required></div></div></div>
    <div class="money-grid"><div class="field"><label>Started with ($)</label><input name="started" type="number" min="0" step="1" value="${esc(s.started)}" required></div><div class="field"><label>Finished with ($)</label><input name="finished" type="number" min="0" step="1" value="${esc(s.finished)}" required></div></div>
   </section>
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
  const gameLayer=`${xpPanel()}${achievementPanel()}`;
  if(ss.length<3) return appShell(`${header('Stats','Progress, patterns and momentum.',false)}${gameLayer}<div class="notice"><strong>More patterns unlock after 3 sessions.</strong><br>Keep logging honestly; we’ll only surface comparisons when there is enough data.</div>`,'insights');
  const lowTilt=ss.filter(x=>x.tilt<=4), highTilt=ss.filter(x=>x.tilt>=7);
  const calm=ss.filter(x=>x.state==='Calm'||x.state==='Focused'), tense=ss.filter(x=>x.state==='Tense'||x.state==='Tilted');
  const lowJudgment=ss.filter(x=>x.judgment<=4), highJudgment=ss.filter(x=>x.judgment>=7);
  const allProcess=avg(ss.map(x=>x.process));
  const best=ss.slice().sort((a,b)=>b.process-a.process)[0];
  const cards=[];
  if(lowTilt.length&&highTilt.length){const a=avg(lowTilt.map(x=>x.process)),b=avg(highTilt.map(x=>x.process));cards.push(simpleCompare('Tilt vs. decision quality','Low tilt',a,'High tilt',b,a>b?`You tend to play ${Math.abs(a-b).toFixed(1)} process points better when tilt stays low.`:`Your process score is currently similar regardless of tilt.`));}
  if(calm.length&&tense.length){const a=avg(calm.map(x=>x.process)),b=avg(tense.map(x=>x.process));cards.push(simpleCompare('Mental state vs. process','Calm / focused',a,'Tense / tilted',b,a>b?'Your calmer sessions have produced better decision quality so far.':'There is not a clear mental-state pattern yet.'));}
  if(lowJudgment.length&&highJudgment.length){const a=avg(lowJudgment.map(x=>x.process)),b=avg(highJudgment.map(x=>x.process));cards.push(simpleCompare('Self-judgment vs. process','Less judgment',a,'More judgment',b,a>b?'Being less self-critical is associated with better process in your saved sessions.':'No clear relationship yet between self-judgment and process.'));}
  return appShell(`${header('Stats','Progress, patterns and momentum.',false)}
    ${gameLayer}
    <section class="card pad insight-hero"><small>Average process score</small><strong>${allProcess.toFixed(1)}<span>/10</span></strong><div class="process-pill">${processBucketLabel(allProcess)}</div><p>${best?`Your strongest saved session was ${best.process}/10 on ${esc(best.startDate||best.date)}.`:''}</p></section>
    <div class="stack">${cards.length?cards.join(''):'<div class="notice"><strong>No strong comparison yet.</strong><br>Keep logging sessions. We only show a comparison when both sides have enough examples.</div>'}</div>
    <div class="notice"><strong>Next focus</strong><br>${recommendation(ss)}</div>`,'insights');
}
function recommendation(ss){ if(ss.length<3)return 'Keep the routine consistent for a few sessions. The app will surface patterns once there is enough data.'; const c=corr(ss.map(x=>x.judgment),ss.map(x=>x.process)); if(c!==null&&c<-.25)return 'Try replacing self-criticism with one neutral observation after a difficult hand.'; const t=corr(ss.map(x=>x.tilt),ss.map(x=>x.process)); if(t!==null&&t<-.25)return 'Protect your process when tilt rises: use the hourly reset or end the session if you stop following your plan.'; return 'Keep one clear process goal per session and compare it with your post-session process score.'; }

function profile(){
  const rooms=knownRooms();
  return appShell(`${header('More','Your games, rooms and local data.',false)}
  <div class="stack">
    ${xpPanel(true)}
    <section class="card pad"><div class="row between section-head"><div><div class="section-title">Rooms</div><div class="session-meta">Saved automatically from your sessions.</div></div><span>${rooms.length}</span></div>${rooms.length?`<div class="room-list">${rooms.map(r=>`<span>${esc(r)}</span>`).join('')}</div>`:'<div class="empty">No rooms saved yet.</div>'}</section>
    <section class="card pad"><div class="section-title">Games</div><div class="room-list">${knownGames().map(g=>`<span>${esc(g)}</span>`).join('')}</div></section>
    <section class="card pad"><div class="section-title">Local-first data</div><p class="body-copy">No account and no server are required. Sessions, prep settings, rooms and insights are stored locally on this phone.</p></section>
    <button class="btn secondary" id="exportData">Export my data</button>
    <button class="btn secondary" id="seedDemo">Add demo sessions</button>
    <button class="btn secondary danger-text" id="clearData">Clear all local data</button>
  </div>`,'profile');
}
function render(){ const app=document.getElementById('app'); app.innerHTML = ({home,prep:prepOverview,breathe,goals,handsIntro,handPlay,handExplain,handsComplete,review,active:activeSession,log:logSession,sessions,editSession,insights,profile}[route]||home)(); bind(); if(route==='active')startSessionTicker(); }
function bind(){
  document.querySelectorAll('[data-nav]').forEach(el=>el.onclick=()=>navigate(el.dataset.nav));
  document.querySelectorAll('[data-back]').forEach(el=>el.onclick=()=>navigate(route==='editSession'?'sessions':route==='log'||route==='active'?'home':route==='breathe'?'prep':route==='goals'?'breathe':route==='handsIntro'?'goals':route==='handPlay'?'handsIntro':route==='handExplain'?'handPlay':route==='handsComplete'?'handsIntro':route==='review'?'handsIntro':'home'));
  const startPrep=document.querySelector('[data-start-prep]'); if(startPrep)startPrep.onclick=beginPreparation;
  document.querySelectorAll('[data-breath-level]').forEach(el=>el.onclick=()=>{ breathLevel=el.dataset.breathLevel; state.prep.breathLevel=breathLevel; save(); resetBreath(); });
  document.querySelectorAll('[data-breath-workout]').forEach(el=>el.onclick=()=>{ breathWorkout=el.dataset.breathWorkout; state.prep.breathWorkout=breathWorkout; save(); resetBreath(); });
  const toggle=document.getElementById('breathToggle'); if(toggle)toggle.onclick=()=>breathRunning?(stopBreath(),render()):startBreath();
  const reset=document.getElementById('breathReset'); if(reset)reset.onclick=resetBreath;
  const comp=document.querySelector('[data-complete-breath]'); if(comp)comp.onclick=()=>{stopBreath();state.prep.breathLevel=breathLevel;state.prep.breathWorkout=breathWorkout;save();navigate('goals')};
  document.querySelectorAll('[data-goal-input]').forEach(el=>el.oninput=()=>{ const i=Number(el.dataset.goalInput); while(state.prep.goals.length<3)state.prep.goals.push(''); state.prep.goals[i]=el.value; const c=document.getElementById('goalCount'); if(c)c.textContent=`${state.prep.goals.filter(g=>String(g).trim()).length}/3`; save(); });
  document.querySelectorAll('[data-range]').forEach(el=>el.oninput=()=>{ const k=el.dataset.range, v=Number(el.value); if(['energy','focus','noise'].includes(k))state.prep[k]=v; const out=document.getElementById(`v-${k}`); if(out)out.textContent=v; save(); });
  document.querySelectorAll('[data-env]').forEach(el=>el.onclick=()=>{ const k=el.dataset.env; state.prep.environment[k]=!state.prep.environment[k]; save(); render(); });
  document.querySelectorAll('[data-prep-text]').forEach(el=>el.oninput=()=>{state.prep[el.dataset.prepText]=el.value;save();});
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
    const now=Date.now(), parts=toLocalParts(now);
    rememberGame(state.prep.stakes); state.activeSession={startedAt:now,date:parts.date,startDate:parts.date,startTime:parts.time,stakes:normalizeGameName(state.prep.stakes),room:String(state.prep.room||'').trim(),startedAmount:amount,prep:structuredClone(state.prep)};
    save(); scheduleBreakReminders(); navigate('active');
  };
  const finish=document.querySelector('[data-finish-session]'); if(finish)finish.onclick=()=>navigate('log');
  const f=document.getElementById('logForm'); if(f)f.onsubmit=e=>{
    e.preventDefault(); const fd=new FormData(f), started=Number(fd.get('started')),finished=Number(fd.get('finished'));
    const process=Number(document.querySelector('[data-range="process"]')?.value||7), judgment=Number(document.querySelector('[data-range="judgment"]')?.value||4), tilt=Number(document.querySelector('[data-range="tilt"]')?.value||3), trust=Number(document.querySelector('[data-range="trust"]')?.value||7);
    const mental=state.activeSession?.prep; const scoreState = tilt>=8?'Tilted':(mental?.noise??5)<=3&&tilt<=4?'Calm':trust>=7?'Focused':'Tense';
    const startAt=localDateTime(fd.get('startDate'),fd.get('startTime')), endAt=localDateTime(fd.get('endDate'),fd.get('endTime'));
    if(!startAt||!endAt||endAt<startAt){alert('Please check the start and end date/time.');return;}
    const durationMs=endAt-startAt;
    rememberGame(fd.get('game')); state.sessions.push({id:crypto.randomUUID?.()||String(Date.now()),date:fd.get('startDate'),startDate:fd.get('startDate'),startTime:fd.get('startTime'),endDate:fd.get('endDate'),endTime:fd.get('endTime'),startedAt:startAt,endedAt:endAt,room:String(fd.get('room')||'').trim(),game:normalizeGameName(fd.get('game')),started,finished,pnl:finished-started,process,judgment,tilt,trust,state:scoreState,note:fd.get('note'),prep:mental||null,durationMs});
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
    const startAt=localDateTime(fd.get('startDate'),fd.get('startTime')),endAt=localDateTime(fd.get('endDate'),fd.get('endTime'));
    if(!startAt||!endAt||endAt<startAt){alert('Please check the start and end date/time.');return;}
    rememberGame(fd.get('game')); Object.assign(item,{date:fd.get('startDate'),startDate:fd.get('startDate'),startTime:fd.get('startTime'),endDate:fd.get('endDate'),endTime:fd.get('endTime'),startedAt:startAt,endedAt:endAt,durationMs:endAt-startAt,room:String(fd.get('room')||'').trim(),game:normalizeGameName(fd.get('game')),started,finished,pnl:finished-started,process,judgment,tilt,trust,note:fd.get('note')}); item.state=tilt>=8?'Tilted':(item.prep?.noise??5)<=3&&tilt<=4?'Calm':trust>=7?'Focused':'Tense'; save(); editingSessionId=null; navigate('sessions');
  };
  document.querySelectorAll('[data-money-range]').forEach(el=>el.onclick=()=>{moneyRange=el.dataset.moneyRange;selectedMoneyPoint=null;render();});
  document.querySelectorAll('[data-money-mode]').forEach(el=>el.onclick=()=>{moneyMode=el.dataset.moneyMode;selectedMoneyPoint=null;render();});
  document.querySelectorAll('[data-money-point]').forEach(el=>{const pick=()=>{selectedMoneyPoint=Number(el.dataset.moneyPoint);render();};el.onclick=pick;el.onfocus=pick;});
  const moneyChart=document.getElementById('moneyChart'); if(moneyChart){
    const pickNearest=e=>{const rect=moneyChart.getBoundingClientRect(),x=(e.touches?.[0]?.clientX??e.clientX)-rect.left,rows=filterMoneySessions();if(!rows.length)return;selectedMoneyPoint=Math.max(0,Math.min(rows.length-1,Math.round((x/Math.max(1,rect.width))*(rows.length-1))));render();};
    moneyChart.onpointerdown=pickNearest; moneyChart.ontouchstart=pickNearest;
  }
  const moneyGameFilter=document.getElementById('moneyGameFilter'); if(moneyGameFilter)moneyGameFilter.onchange=()=>{moneyGame=moneyGameFilter.value;selectedMoneyPoint=null;render();};
  const exp=document.getElementById('exportData'); if(exp)exp.onclick=()=>{const blob=new Blob([JSON.stringify(state,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='inner-game-data.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),500)};
  const seed=document.getElementById('seedDemo'); if(seed)seed.onclick=()=>{seedDemo();save();navigate('insights');};
  const clear=document.getElementById('clearData'); if(clear)clear.onclick=()=>{if(confirm('Delete all locally stored Inner Game data?')){cancelBreakReminders();localStorage.removeItem(STORAGE_KEY);LEGACY_STORAGE_KEYS.forEach(k=>localStorage.removeItem(k));location.reload();}};
}
function seedDemo(){ if(state.sessions.length)return; const rows=[[500,820,8,2,2,8,'Calm'],[500,340,5,7,8,4,'Tilted'],[500,620,7,3,4,7,'Focused'],[500,450,6,5,6,6,'Tense'],[500,760,9,2,2,9,'Calm'],[500,540,8,3,3,8,'Focused']]; rows.forEach((r,i)=>state.sessions.push({id:String(Date.now()+i),date:new Date(Date.now()-(rows.length-i)*86400000).toISOString().slice(0,10),game:'NL100',started:r[0],finished:r[1],pnl:r[1]-r[0],process:r[2],judgment:r[3],tilt:r[4],trust:r[5],state:r[6],note:'Demo session',durationMs:5400000})); }

save();
render();
