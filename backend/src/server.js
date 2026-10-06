import express from "express";
import cors from "cors";
import OpenAI from "openai";
import { z } from "zod";

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "18mb" }));

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const POKERAI_BASE = process.env.POKERAI_API_BASE || "https://pokerai.bet";
const POKERAI_KEY = process.env.POKERAI_API_KEY || "";

const handSchema = z.object({
  isPokerHand: z.boolean(),
  confidence: z.number().min(0).max(1),
  site: z.string().default(""),
  gameType: z.enum(["cash","tournament","unknown"]).default("unknown"),
  title: z.string().default(""),
  tournamentName: z.string().default(""),
  visibleEventText: z.string().default(""),
  stakes: z.string().default(""),
  blinds: z.string().default(""),
  tableType: z.string().default(""),
  heroPosition: z.string().default(""),
  heroCards: z.array(z.string()).max(2).default([]),
  board: z.array(z.string()).max(5).default([]),
  pot: z.string().default(""),
  actionSummary: z.string().default(""),
  description: z.string().default(""),
  uncertainFields: z.array(z.string()).default([])
});

const schema = {
  type:"object",
  additionalProperties:false,
  required:["isPokerHand","confidence","site","gameType","title","tournamentName","visibleEventText","stakes","blinds","tableType","heroPosition","heroCards","board","pot","actionSummary","description","uncertainFields"],
  properties:{
    isPokerHand:{type:"boolean"},
    confidence:{type:"number",minimum:0,maximum:1},
    site:{type:"string"},
    gameType:{type:"string",enum:["cash","tournament","unknown"]},
    title:{type:"string"},
    tournamentName:{type:"string"},
    visibleEventText:{type:"string"},
    stakes:{type:"string"},
    blinds:{type:"string"},
    tableType:{type:"string"},
    heroPosition:{type:"string"},
    heroCards:{type:"array",items:{type:"string"},maxItems:2},
    board:{type:"array",items:{type:"string"},maxItems:5},
    pot:{type:"string"},
    actionSummary:{type:"string"},
    description:{type:"string"},
    uncertainFields:{type:"array",items:{type:"string"}}
  }
};

const solverActionSchema = z.object({
  street:z.enum(["preflop","flop","turn","river"]),
  position:z.string(),
  action:z.enum(["small_blind","big_blind","fold","check","call","bet","raise","allin","unknown"]),
  amountBb:z.number(),
  sizePctPot:z.number()
});

const solverSpotSchema = z.object({
  confidence:z.number().min(0).max(1),
  game:z.enum(["NLH","unknown"]),
  format:z.enum(["cash","tournament","unknown"]),
  tableSize:z.number().int(),
  heroPosition:z.string(),
  villainPosition:z.string(),
  heroRole:z.enum(["OOP","IP","unknown"]),
  heroCards:z.array(z.string()).max(2),
  board:z.array(z.string()).max(5),
  decisionStreet:z.enum(["preflop","flop","turn","river","unknown"]),
  effectiveStackBb:z.number(),
  potAtDecisionBb:z.number(),
  heroStackBb:z.number(),
  villainStackBb:z.number(),
  flopStartPotBb:z.number(),
  flopStartEffectiveStackBb:z.number(),
  actionHistoryComplete:z.boolean(),
  observedHeroAction:z.enum(["fold","check","call","bet","raise","allin","unknown"]),
  observedHeroAmountBb:z.number(),
  actionHistory:z.array(solverActionSchema),
  missingFields:z.array(z.string()),
  extractionNotes:z.array(z.string())
});

const solverInspectJsonSchema = {
  type:"object",
  additionalProperties:false,
  required:["confidence","game","format","tableSize","heroPosition","villainPosition","heroRole","heroCards","board","decisionStreet","effectiveStackBb","potAtDecisionBb","heroStackBb","villainStackBb","flopStartPotBb","flopStartEffectiveStackBb","actionHistoryComplete","observedHeroAction","observedHeroAmountBb","actionHistory","missingFields","extractionNotes"],
  properties:{
    confidence:{type:"number",minimum:0,maximum:1},
    game:{type:"string",enum:["NLH","unknown"]},
    format:{type:"string",enum:["cash","tournament","unknown"]},
    tableSize:{type:"integer"},
    heroPosition:{type:"string"},
    villainPosition:{type:"string"},
    heroRole:{type:"string",enum:["OOP","IP","unknown"]},
    heroCards:{type:"array",items:{type:"string"},maxItems:2},
    board:{type:"array",items:{type:"string"},maxItems:5},
    decisionStreet:{type:"string",enum:["preflop","flop","turn","river","unknown"]},
    effectiveStackBb:{type:"number"},
    potAtDecisionBb:{type:"number"},
    heroStackBb:{type:"number"},
    villainStackBb:{type:"number"},
    flopStartPotBb:{type:"number"},
    flopStartEffectiveStackBb:{type:"number"},
    actionHistoryComplete:{type:"boolean"},
    observedHeroAction:{type:"string",enum:["fold","check","call","bet","raise","allin","unknown"]},
    observedHeroAmountBb:{type:"number"},
    actionHistory:{
      type:"array",
      items:{
        type:"object",
        additionalProperties:false,
        required:["street","position","action","amountBb","sizePctPot"],
        properties:{
          street:{type:"string",enum:["preflop","flop","turn","river"]},
          position:{type:"string"},
          action:{type:"string",enum:["small_blind","big_blind","fold","check","call","bet","raise","allin","unknown"]},
          amountBb:{type:"number"},
          sizePctPot:{type:"number"}
        }
      }
    },
    missingFields:{type:"array",items:{type:"string"}},
    extractionNotes:{type:"array",items:{type:"string"}}
  }
};

const explanationSchema = {
  type:"object",
  additionalProperties:false,
  required:["summary","details","facts"],
  properties:{
    summary:{type:"string"},
    details:{type:"string"},
    facts:{type:"array",items:{type:"string"}}
  }
};

function validateCards(cards){
  const rx=/^(10|[2-9TJQKA])[shdc♠♥♦♣]?$/i;
  return (cards||[]).filter(c=>rx.test(String(c).trim()));
}
function normalizeCard(card=""){
  return String(card).replace("10","T").replace("♠","s").replace("♥","h").replace("♦","d").replace("♣","c").trim();
}
function cleanTournamentText(value=""){
  return String(value||"")
    .replace(/\s+/g," ")
    .replace(/\s*-\s*\d+(?:st|nd|rd|th)?\s*Pla(?:ce)?\b.*$/i,"")
    .replace(/\s*Blinds?\b.*$/i,"")
    .replace(/\s*(?:Next Prize|Prize Jump|My Rank)\b.*$/i,"")
    .trim();
}
function sleep(ms){ return new Promise(resolve=>setTimeout(resolve,ms)); }
function pokeraiHeaders(){
  return {
    Authorization:`Bearer ${POKERAI_KEY}`,
    "Content-Type":"application/json",
    Accept:"application/json"
  };
}
async function pokeraiPost(path, body){
  const response = await fetch(POKERAI_BASE + path, {
    method:"POST",
    headers:pokeraiHeaders(),
    body:JSON.stringify(body)
  });
  let json={};
  try{ json=await response.json(); }catch{}
  if(!response.ok){
    const error = new Error(json?.message || json?.reason || json?.error || `Pokerai HTTP ${response.status}`);
    error.status=response.status;
    error.code=json?.error || json?.status || "pokerai_error";
    error.payload=json;
    throw error;
  }
  return json;
}
function positionOrder(position){
  return ({SB:0,BB:1,UTG:2,MP:3,HJ:3,CO:4,BTN:5})[String(position||"").toUpperCase()] ?? 99;
}
function normalizePosition(position=""){
  const p=String(position||"").toUpperCase().replace("BUTTON","BTN").replace("BIG BLIND","BB").replace("SMALL BLIND","SB").trim();
  return p==="HJ" ? "MP" : p;
}
function preflopVersion(stackBb){
  return Number(stackBb)>0 && Number(stackBb)<=60 ? "6max_RC_40bb" : "6max_RC_100bb_200NL";
}
function actionKey(action){
  const a=String(action||"").toLowerCase();
  if(a==="allin") return "raise";
  if(["raise","bet"].includes(a)) return "raise";
  if(a==="call") return "call";
  if(a==="fold") return "fold";
  return a;
}
function pokeraiPreflopAction(a){
  const actionMap={
    small_blind:"small blind",
    big_blind:"big blind",
    fold:"fold",
    call:"call",
    raise:"raise",
    allin:"raise"
  };
  const mapped=actionMap[a.action];
  if(!mapped) return null;
  const out={position:normalizePosition(a.position),action:mapped};
  if(a.action!=="fold") out.amount=Math.max(0,Number(a.amountBb)||0);
  if(a.action==="allin") out.allin=true;
  return out;
}
function rangeStringFromGrid(range, chosenAction){
  const key=actionKey(chosenAction);
  return Object.entries(range||{})
    .map(([hand,frequencies])=>[hand,Number(frequencies?.[key]||0)])
    .filter(([,frequency])=>frequency>0.001)
    .map(([hand,frequency])=>`${hand}:${Math.min(1,frequency).toFixed(5)}`)
    .join(",");
}
async function derivePlayerPreflopRange(spot, position){
  const pre=(spot.actionHistory||[]).filter(a=>a.street==="preflop");
  let lastIndex=-1;
  for(let i=0;i<pre.length;i++) if(normalizePosition(pre[i].position)===normalizePosition(position) && !["small_blind","big_blind"].includes(pre[i].action)) lastIndex=i;
  if(lastIndex<0) throw Object.assign(new Error(`Missing final preflop action for ${position}`),{code:"missing_preflop_range_action"});
  const chosen=pre[lastIndex];
  if(!["fold","call","raise","allin"].includes(chosen.action)) throw Object.assign(new Error(`Unsupported preflop action for ${position}`),{code:"unsupported_preflop_range_action"});
  const prior=pre.slice(0,lastIndex).map(pokeraiPreflopAction).filter(Boolean);
  const body={
    table_size:"6max",
    positions:{hero:normalizePosition(position)},
    preflop_version:preflopVersion(spot.flopStartEffectiveStackBb||spot.effectiveStackBb),
    preflop_actions:prior
  };
  const result=await pokeraiPost("/v1/gto/preflop/range",body);
  const range=rangeStringFromGrid(result.range,chosen.action);
  if(!range) throw Object.assign(new Error(`No continuing range for ${position}`),{code:"empty_preflop_range"});
  return {range,version:body.preflop_version,chosenAction:chosen.action};
}

function ensureBlindPosts(spot){
  const actions=Array.isArray(spot.actionHistory)?spot.actionHistory:[];
  const pre=actions.filter(a=>a.street==="preflop");
  const hasSb=pre.some(a=>a.action==="small_blind");
  const hasBb=pre.some(a=>a.action==="big_blind");
  if(!hasSb || !hasBb){
    const posts=[];
    if(!hasSb)posts.push({street:"preflop",position:"SB",action:"small_blind",amountBb:0.5,sizePctPot:0});
    if(!hasBb)posts.push({street:"preflop",position:"BB",action:"big_blind",amountBb:1,sizePctPot:0});
    spot.actionHistory=[...posts,...actions];
    spot.extractionNotes=[...(spot.extractionNotes||[]),"Standard SB/BB posts normalized in big-blind units for the solver."];
  }
  return spot;
}
function stripObservedHeroDecision(spot){
  const action=String(spot.observedHeroAction||"unknown").toLowerCase();
  if(action==="unknown"||!spot.heroPosition)return spot;
  const rows=Array.isArray(spot.actionHistory)?spot.actionHistory:[];
  for(let i=rows.length-1;i>=0;i--){
    const a=rows[i];
    if(a.street!==spot.decisionStreet)continue;
    if(normalizePosition(a.position)===normalizePosition(spot.heroPosition) && a.action===action){
      rows.splice(i,1);
      spot.extractionNotes=[...(spot.extractionNotes||[]),"Hero's observed decision is stored separately and excluded from the solver action path."];
    }
    break;
  }
  spot.actionHistory=rows;
  return spot;
}
function solverActionHistoryIssues(spot){
  const issues=[];
  const rows=Array.isArray(spot.actionHistory)?spot.actionHistory:[];
  const pre=rows.filter(a=>a.street==="preflop");
  if(pre.length<2 || pre[0]?.action!=="small_blind" || normalizePosition(pre[0]?.position)!=="SB" || pre[1]?.action!=="big_blind" || normalizePosition(pre[1]?.position)!=="BB"){
    issues.push("Action history must start with the small blind and big blind posts");
  }
  if(rows.some(a=>a.action==="unknown"))issues.push("Action history contains an unknown action");
  const hero=normalizePosition(spot.heroPosition), villain=normalizePosition(spot.villainPosition);
  for(const street of ["flop","turn","river"]){
    const actions=rows.filter(a=>a.street===street);
    if(!actions.length)continue;
    let outstanding=false,terminal=false,lastActor="",checks=0;
    for(const a of actions){
      const actor=normalizePosition(a.position);
      if(hero&&villain&&actor!==hero&&actor!==villain){
        issues.push(`${street}: action assigned to ${actor||"an unknown player"} after the hand should be heads-up`);
        break;
      }
      if(terminal){
        issues.push(`${street}: action appears after the betting round already ended`);
        break;
      }
      if(lastActor&&actor===lastActor){
        issues.push(`${street}: the same player acts twice in a row`);
        break;
      }
      if(a.action==="check"){
        if(outstanding){issues.push(`${street}: check appears while facing a bet`);break;}
        checks+=1;
        if(checks>=2)terminal=true;
      }else if(a.action==="bet"){
        if(outstanding){issues.push(`${street}: bet appears while a bet is already outstanding`);break;}
        outstanding=true;checks=0;
      }else if(["raise","allin"].includes(a.action)){
        if(!outstanding){issues.push(`${street}: raise appears without a prior bet`);break;}
        outstanding=true;checks=0;
      }else if(a.action==="call"){
        if(!outstanding){issues.push(`${street}: call appears without a bet to call`);break;}
        outstanding=false;terminal=true;checks=0;
      }else if(a.action==="fold"){
        if(!outstanding){issues.push(`${street}: fold appears without a bet to fold to`);break;}
        terminal=true;checks=0;
      }
      lastActor=actor;
    }
    if(street!==spot.decisionStreet && actions.length && !terminal){
      issues.push(`${street}: betting round is incomplete`);
    }
  }
  return [...new Set(issues)];
}
function normalizeSolverSpot(spot){
  spot.heroCards=validateCards(spot.heroCards).map(normalizeCard);
  spot.board=validateCards(spot.board).map(normalizeCard);
  spot.heroPosition=normalizePosition(spot.heroPosition);
  spot.villainPosition=normalizePosition(spot.villainPosition);
  spot.actionHistory=(spot.actionHistory||[]).map(a=>({...a,position:normalizePosition(a.position)}));
  ensureBlindPosts(spot);
  stripObservedHeroDecision(spot);
  return spot;
}
async function extractSolverSpot(imageDataUrl,hand={},repairContext=null){
  const prompt=[
    "Prepare this saved poker screenshot for a post-hand GTO solver.",
    "This is review/study after the hand, never real-time assistance.",
    "The screenshot is the source of truth. Existing saved-hand metadata is only a hint.",
    "CRITICAL HERO IDENTIFICATION: Hero is the user-controlled seat with the user's own hole cards, usually the bottom-center seat in poker clients/replayers. Do NOT use an opponent's cards shown later in a winner/showdown/result panel as Hero's cards.",
    "In hand-history/replayer screenshots, colored/yellow action boxes without a player avatar/name often belong to Hero. Named/avatar action bubbles belong to the named opponent. Use the visual column/order to assign every action to the correct player.",
    "If the hand result is already visible, identify Hero's actual decision (fold/call/bet/raise/check/all-in) in observedHeroAction, but EXCLUDE that Hero decision from actionHistory. actionHistory must end immediately before Hero's decision so the solver evaluates that decision.",
    "We may solve ONLY if every action from blind posting/preflop through the exact Hero decision is known.",
    "actionHistory MUST start with the blind posts in this exact logical order: SB small_blind 0.5 BB, then BB big_blind 1 BB. Keep them even if they seem obvious.",
    "Never invent an action that is not visible or logically forced by visible information.",
    "If any action, position, card, stack, or required sizing is missing or ambiguous, actionHistoryComplete MUST be false and missingFields must say exactly what the user needs to fix.",
    "Include visible preflop folds needed to reconstruct the action path.",
    "For bet/raise amountBb use the absolute wager/raise-to amount in big blinds on that street when it can be determined. For call, amountBb is the additional amount called when the client displays it; for checks/folds use 0.",
    "For bet/raise sizePctPot use percentage of the pot immediately BEFORE that bet/raise. Do not compute percent-of-pot for blind posts, calls, checks or folds.",
    "Street header pot labels in hand-history/replayer UIs commonly mean the pot ENTERING that street, not the pot at the later decision. If Villain bets on that street, potAtDecisionBb must include that bet. Example: river starts 14.7 BB and Villain bets 14.7 BB, so Hero faces a 29.4 BB pot.",
    "flopStartPotBb is the displayed/calculated pot entering the flop before flop betting. flopStartEffectiveStackBb is the effective stack behind entering the flop.",
    "Completed-hand replayers may show FINAL seat stacks after the result. Do not blindly copy those into heroStackBb, villainStackBb, effectiveStackBb, or flopStartEffectiveStackBb. Reconstruct the stacks at the decision/at flop start from the visible investments and final result when that arithmetic is reliable; otherwise mark the stack as missing.",
    "heroStackBb/villainStackBb are stacks BEHIND at the screenshot decision, after any Villain bet that Hero is currently facing.",
    "Use canonical positions SB, BB, UTG, MP, CO, BTN for 6-max. Identify the dealer/button marker and blind labels before assigning Hero's position.",
    "heroRole is OOP or IP versus the remaining villain postflop.",
    "Use compact cards such as As, Qh, 7d, Tc.",
    "Sanity-check the sequence: after a fold there cannot be another action on that street; a call must face a bet/raise; postflop the same player cannot act twice consecutively.",
    repairContext ? `A previous extraction failed validation. Re-read the IMAGE and correct it rather than preserving the bad parse. Validation feedback: ${JSON.stringify(repairContext)}` : "",
    `Existing saved hand hint (may itself be wrong): ${JSON.stringify(hand)}`
  ].filter(Boolean).join("\n");
  const response=await client.responses.create({
    model:MODEL,
    input:[{role:"user",content:[
      {type:"input_text",text:prompt},
      {type:"input_image",image_url:imageDataUrl,detail:"high"}
    ]}],
    text:{format:{type:"json_schema",name:"solver_spot_inspection",strict:true,schema:solverInspectJsonSchema}}
  });
  return normalizeSolverSpot(solverSpotSchema.parse(JSON.parse(response.output_text)));
}
function solverReadiness(spot){
  const missing=[];
  if(spot.game!=="NLH") missing.push("No-limit Hold’em");
  if(!Number.isFinite(spot.tableSize)||spot.tableSize<2) missing.push("Table size");
  if(!spot.heroPosition) missing.push("Hero position");
  if(spot.decisionStreet==="unknown") missing.push("Decision street");
  if((spot.heroCards||[]).length!==2) missing.push("Hero cards");
  const boardNeed=spot.decisionStreet==="flop"?3:spot.decisionStreet==="turn"?4:spot.decisionStreet==="river"?5:0;
  if(boardNeed && (spot.board||[]).length<boardNeed) missing.push("Board");
  if(!spot.actionHistoryComplete) missing.push("Complete action history from preflop to this decision");
  missing.push(...solverActionHistoryIssues(spot));
  if(spot.decisionStreet!=="preflop"){
    if(!spot.villainPosition) missing.push("Villain position");
    if(!(spot.flopStartPotBb>0)) missing.push("Pot entering flop");
    if(!(spot.flopStartEffectiveStackBb>0)) missing.push("Effective stack entering flop");
  }
  return [...new Set([...(spot.missingFields||[]),...missing])];
}
function actionSegment(action){
  if(action.action==="check")return {type:"CHECK"};
  if(action.action==="call")return {type:"CALL"};
  if(action.action==="bet")return {type:"BET",amount:Number(action.amountBb)||0};
  if(["raise","allin"].includes(action.action))return {type:"RAISE",amount:Number(action.amountBb)||0};
  if(action.action==="fold")return {type:"FOLD"};
  return null;
}
function expectedPostflopSegments(spot){
  // Pokerai's later-street trees preserve the full path from flop root and
  // insert turn/river cards as chance nodes, e.g.
  // root/CHECK/BET .../CALL/2s/CHECK/.../Jd/BET ...
  const segments=[];
  const board=(spot.board||[]).map(normalizeCard);
  for(const street of ["flop","turn","river"]){
    for(const action of (spot.actionHistory||[]).filter(a=>a.street===street)){
      const segment=actionSegment(action);
      if(segment)segments.push(segment);
    }
    if(street==="flop" && board[3])segments.push({type:"CARD",card:board[3]});
    if(street==="turn" && board[4])segments.push({type:"CARD",card:board[4]});
    if(street===spot.decisionStreet)break;
  }
  return segments;
}
function parseNodeSegments(node){
  return String(node||"").split("/").slice(1).map(raw=>{
    const s=raw.trim();
    if(/^[2-9TJQKA][shdc]$/i.test(s)) return {type:"CARD",card:s};
    const match=s.match(/^(BET|RAISE)\s+([0-9.]+)/i);
    if(match)return {type:match[1].toUpperCase(),amount:Number(match[2])};
    if(/^(CHECK|CALL|FOLD)$/i.test(s))return {type:s.toUpperCase()};
    return {type:s.toUpperCase()};
  });
}
function nodeMatchScore(node, expected){
  const got=parseNodeSegments(node);
  if(got.length!==expected.length)return Infinity;
  let score=0;
  for(let i=0;i<got.length;i++){
    if(got[i].type!==expected[i].type)return Infinity;
    if(got[i].type==="CARD"){
      if(String(got[i].card).toLowerCase()!==String(expected[i].card).toLowerCase())return Infinity;
    }else if(Number.isFinite(expected[i].amount) && ["BET","RAISE"].includes(got[i].type)){
      const tolerance=Math.max(.8,Math.abs(expected[i].amount)*.12);
      const delta=Math.abs(Number(got[i].amount)-Number(expected[i].amount));
      if(delta>tolerance)return Infinity;
      score+=delta;
    }
  }
  return score;
}
function observedSizingConfig(spot){
  const bet_sizes={},raise_sizes={},donk_sizes={};
  for(const street of ["flop","turn","river"]){
    const bets=(spot.actionHistory||[]).filter(a=>a.street===street&&a.action==="bet"&&a.sizePctPot>0).map(a=>Math.round(a.sizePctPot));
    const raises=(spot.actionHistory||[]).filter(a=>a.street===street&&["raise","allin"].includes(a.action)&&a.sizePctPot>0).map(a=>Math.round(a.sizePctPot));
    const baseBets=[33,67,100,...bets];
    bet_sizes[street]=[...new Set(baseBets)].filter(x=>x>=5&&x<=300).slice(0,6);
    // A lead from OOP on a later street after calling the previous street is a
    // donk in Pokerai's tree. Include the observed bet sizings here as well so
    // exact hand-history lines such as a 100% river donk exist in the tree.
    donk_sizes[street]=[...new Set(baseBets)].filter(x=>x>=5&&x<=300).slice(0,6);
    raise_sizes[street]=[...new Set([50,100,...raises])].filter(x=>x>=10&&x<=400).slice(0,6);
  }
  return {bet_sizes,raise_sizes,donk_sizes};
}
async function explainSolution({spot,strategy,evs,bestAction,provider,assumptions}){
  try{
    const response=await client.responses.create({
      model:MODEL,
      input:[{
        role:"user",
        content:[{type:"input_text",text:[
          "Explain this completed poker solver result for post-hand study.",
          "The numerical solver output is the source of truth. Never invent frequencies, EVs, ranges, blockers, exploitative reads, or opponent tendencies.",
          "Do not give live-play instructions. Explain why the solver mixes or prefers the actions using only the supplied facts.",
          "Keep summary to 1-2 sentences and details to at most 4 short sentences.",
          JSON.stringify({spot,strategy,evs,bestAction,provider,assumptions})
        ].join("\n")}]
      }],
      text:{format:{type:"json_schema",name:"solver_explanation",strict:true,schema:explanationSchema}}
    });
    return JSON.parse(response.output_text);
  }catch{
    return {
      summary:"The solver result is shown from its action frequencies and EVs.",
      details:"Use the strategy mix and EV differences above as the primary source of truth.",
      facts:[]
    };
  }
}
function strategyBest(strategy=[]){
  return [...strategy].sort((a,b)=>(Number(b.frequency)||0)-(Number(a.frequency)||0))[0]?.action || "";
}
function evBest(actions=[],values=[]){
  let bestIndex=-1,best=-Infinity;
  values.forEach((v,i)=>{if(Number(v)>best){best=Number(v);bestIndex=i;}});
  return bestIndex>=0?{action:String(actions[bestIndex]||"").toLowerCase(),ev:best}:{action:"",ev:null};
}
function actionFreq(strategy=[],action=""){
  const normalized=String(action).toLowerCase();
  const item=strategy.find(x=>String(x.action||"").toLowerCase()===normalized || String(x.action||"").toLowerCase().startsWith(normalized));
  return item?Number(item.frequency)||0:0;
}

app.get("/health", (_req,res)=>res.json({ok:true,model:MODEL,solver:{pokeraiConfigured:Boolean(POKERAI_KEY)}}));
app.get("/solver/status", (_req,res)=>res.json({
  configured:Boolean(POKERAI_KEY),
  providers:[
    {id:"pokerai",configured:Boolean(POKERAI_KEY),formats:["6max NLH"],stackDepth:"custom postflop; 40bb/100bb standard preflop range seeds"},
    {id:"deepsolver",configured:Boolean(process.env.DEEPSOLVER_API_TOKEN),implemented:false,formats:["NLH postflop"],stackDepth:"custom"}
  ]
}));

app.post("/analyze-hand", async (req,res)=>{
  const startedAt = Date.now();
  try{
    const { imageDataUrl, context={} } = req.body || {};
    if(typeof imageDataUrl!=="string" || !imageDataUrl.startsWith("data:image/")){
      return res.status(400).json({error:"imageDataUrl is required"});
    }
    if(imageDataUrl.length > 16_000_000) return res.status(413).json({error:"Image too large"});

    const prompt = [
      "Analyze this poker screenshot for Inner Game.",
      "The screenshot is the source of truth. Session context is only a weak hint and must NEVER override visible screenshot text.",
      "Extract only information actually visible or strongly inferable from the screenshot. Do not invent hidden action.",
      "Hero means the user's own seat/hole cards, usually the bottom-center seat. Never label an opponent's showdown/winner cards as heroCards.",
      "First read all visible event/tournament text on the table UI. Preserve the meaningful event name even when it is truncated.",
      "For tournamentName: use the tournament/event name visible in the screenshot, excluding temporary table-state suffixes such as '- 9th Place', blind countdowns, rank, prize jump, or player count.",
      "For visibleEventText: transcribe the visible event/title line as closely as possible.",
      "For title: if this is a tournament, use tournamentName. Do NOT use the session game/stakes as the title when a tournament/event name is visible. For cash games, a concise title such as 'NL100 · GG Poker' is fine.",
      "Example: if the screenshot visibly says 'WSOP $1M Ranking Freeroll - 9th Pla...' then tournamentName/title should be 'WSOP $1M Ranking Freeroll', not the session value 'NL100'.",
      "Prefer compact poker notation for cards such as As, Qh, 7d, Tc.",
      "Description should be one concise sentence summarizing only the visible hand state.",
      context?.sessionGame ? `Session game hint only: ${context.sessionGame}` : "",
      context?.sessionRoom ? `Session room/site hint only: ${context.sessionRoom}` : ""
    ].filter(Boolean).join("\n");

    const response = await client.responses.create({
      model: MODEL,
      input:[{
        role:"user",
        content:[
          {type:"input_text",text:prompt},
          {type:"input_image",image_url:imageDataUrl,detail:"high"}
        ]
      }],
      text:{format:{type:"json_schema",name:"poker_hand_capture",strict:true,schema}}
    });

    const parsed = handSchema.parse(JSON.parse(response.output_text));
    parsed.heroCards = validateCards(parsed.heroCards);
    parsed.board = validateCards(parsed.board);
    if(parsed.gameType==="tournament"){
      parsed.tournamentName = cleanTournamentText(parsed.tournamentName || parsed.visibleEventText);
      if(parsed.tournamentName) parsed.title = parsed.tournamentName;
    }
    console.log(JSON.stringify({event:"hand_analyzed",ms:Date.now()-startedAt,model:MODEL,confidence:parsed.confidence,isPokerHand:parsed.isPokerHand,title:parsed.title}));
    return res.json(parsed);
  }catch(error){
    console.error(JSON.stringify({event:"hand_analysis_failed",ms:Date.now()-startedAt,model:MODEL,error:String(error?.message||error)}));
    return res.status(500).json({error:"Hand analysis failed"});
  }
});

app.post("/solver/inspect", async (req,res)=>{
  const startedAt=Date.now();
  try{
    const {imageDataUrl,hand={}}=req.body||{};
    if(typeof imageDataUrl!=="string"||!imageDataUrl.startsWith("data:image/"))return res.status(400).json({error:"imageDataUrl is required"});
    let spot=await extractSolverSpot(imageDataUrl,hand);
    let issues=solverActionHistoryIssues(spot);
    const heroLooksSuspicious=(hand?.heroCards||[]).length===2 && spot.heroCards.join(" ").toLowerCase()===((hand.heroCards||[]).join(" ").toLowerCase()) && issues.length>0;
    if(issues.length || heroLooksSuspicious){
      try{
        const repaired=await extractSolverSpot(imageDataUrl,hand,{issues,previousSpot:spot});
        if(solverActionHistoryIssues(repaired).length<=issues.length)spot=repaired;
      }catch{}
    }
    spot.missingFields=solverReadiness({...spot,missingFields:[]});
    console.log(JSON.stringify({event:"solver_spot_inspected",ms:Date.now()-startedAt,ready:spot.missingFields.length===0,street:spot.decisionStreet,missing:spot.missingFields.length}));
    return res.json({spot,ready:spot.missingFields.length===0});
  }catch(error){
    console.error(JSON.stringify({event:"solver_spot_inspect_failed",ms:Date.now()-startedAt,error:String(error?.message||error)}));
    return res.status(500).json({error:"Could not prepare this hand for the solver"});
  }
});

app.post("/solver/solve", async (req,res)=>{
  const startedAt=Date.now();
  try{
    if(!POKERAI_KEY)return res.status(503).json({error:"solver_not_configured",message:"Pokerai API key is not configured yet."});
    const spot=normalizeSolverSpot(solverSpotSchema.parse(req.body?.spot||{}));
    const missing=solverReadiness(spot);
    if(missing.length)return res.status(422).json({error:"incomplete_hand",message:"Complete the missing hand details before solving.",missingFields:missing});
    if(spot.tableSize!==6)return res.status(422).json({error:"unsupported_format",message:"The configured Pokerai range seed currently supports 6-max NLH. The provider layer is ready for another format provider."});

    if(spot.decisionStreet==="preflop"){
      const actions=(spot.actionHistory||[]).filter(a=>a.street==="preflop").map(pokeraiPreflopAction).filter(Boolean);
      const result=await pokeraiPost("/v1/gto/preflop",{
        hole_cards:spot.heroCards.join(""),
        positions:{hero:spot.heroPosition},
        preflop_version:preflopVersion(spot.effectiveStackBb),
        preflop_actions:actions
      });
      const strategy=result.strategy||[];
      const bestAction=strategyBest(strategy);
      const assumptions=[`Pokerai ${preflopVersion(spot.effectiveStackBb)} preflop chart`,"6-max NLH","Post-hand study only"];
      const explanation=await explainSolution({spot,strategy,evs:null,bestAction,provider:"pokerai",assumptions});
      return res.json({status:"solved",solution:{provider:"pokerai",street:"preflop",strategy,bestAction,evs:null,explanation,assumptions}});
    }

    const [heroRangeInfo,villainRangeInfo]=await Promise.all([
      derivePlayerPreflopRange(spot,spot.heroPosition),
      derivePlayerPreflopRange(spot,spot.villainPosition)
    ]);
    const heroIsOop=spot.heroRole==="OOP" || (spot.heroRole==="unknown" && positionOrder(spot.heroPosition)<positionOrder(spot.villainPosition));
    const oopRange=heroIsOop?heroRangeInfo.range:villainRangeInfo.range;
    const ipRange=heroIsOop?villainRangeInfo.range:heroRangeInfo.range;
    const sizing=observedSizingConfig(spot);
    const schedule=await pokeraiPost("/v1/gto/solver",{
      board:spot.board.slice(0,3).join(""),
      oop_range:oopRange,
      ip_range:ipRange,
      pot:spot.flopStartPotBb,
      effective_stack:spot.flopStartEffectiveStackBb,
      hero:heroIsOop?"OOP":"IP",
      bet_sizes:sizing.bet_sizes,
      raise_sizes:sizing.raise_sizes,
      donk_sizes:sizing.donk_sizes,
      raise_limit:3
    });
    const solve=schedule.solve;
    if(!solve)return res.status(502).json({error:"solver_schedule_failed",message:"The solver did not return a solve handle."});
    const assumptions=[
      `Exact postflop stack: ${spot.flopStartEffectiveStackBb} BB entering flop`,
      `Hero preflop range seeded from ${heroRangeInfo.version}`,
      `Villain preflop range seeded from ${villainRangeInfo.version}`,
      ...(spot.format==="tournament"?["Tournament postflop is solved in chip EV; preflop seed uses the nearest available 6-max 40bb/100bb chart, not ICM."]:[]),
      "Observed bet sizes included in the custom tree",
      "Post-hand study only"
    ];
    console.log(JSON.stringify({event:"solver_scheduled",ms:Date.now()-startedAt,street:spot.decisionStreet,solve:solve.slice(0,12)}));
    return res.status(202).json({
      status:"pending",
      job:{
        provider:"pokerai",
        solve,
        heroHand:spot.heroCards.join(""),
        decisionStreet:spot.decisionStreet,
        turnCard:spot.board[3]||"",
        riverCard:spot.board[4]||"",
        expectedSegments:expectedPostflopSegments(spot),
        spot,
        assumptions,
        createdAt:Date.now()
      }
    });
  }catch(error){
    console.error(JSON.stringify({event:"solver_schedule_failed",ms:Date.now()-startedAt,code:error?.code,error:String(error?.message||error)}));
    return res.status(error?.status&&error.status<500?error.status:500).json({error:error?.code||"solver_failed",message:String(error?.message||"Solver failed")});
  }
});

app.post("/solver/poll", async (req,res)=>{
  const startedAt=Date.now();
  try{
    if(!POKERAI_KEY)return res.status(503).json({error:"solver_not_configured",message:"Pokerai API key is not configured yet."});
    const job=req.body?.job||{};
    if(!job.solve)return res.status(400).json({error:"missing_job",message:"Missing solver job."});
    const treeBody={solve:job.solve};
    if(job.decisionStreet==="turn"||job.decisionStreet==="river")treeBody.turn_card=job.turnCard;
    if(job.decisionStreet==="river")treeBody.river_card=job.riverCard;
    const tree=await pokeraiPost("/v1/gto/solver/tree",treeBody);
    if(["available","computing"].includes(tree.spot_status))return res.status(202).json({status:"pending",spotStatus:tree.spot_status});
    if(tree.spot_status!=="queryable")return res.status(422).json({error:"solver_not_queryable",message:`Solver state: ${tree.spot_status||"unknown"}`});
    const expected=Array.isArray(job.expectedSegments)?job.expectedSegments:[];
    const candidates=(tree.nodes||[]).filter(n=>n.is_hero);
    const scored=candidates.map(n=>({node:n,score:nodeMatchScore(n.node,expected)})).filter(x=>Number.isFinite(x.score)).sort((a,b)=>a.score-b.score);
    const target=scored[0]?.node;
    if(!target){
      console.warn(JSON.stringify({
        event:"solver_node_match_failed",
        street:job.decisionStreet,
        expected,
        availableHeroNodes:candidates.slice(0,20).map(n=>n.node)
      }));
      return res.status(422).json({
        error:"action_path_not_in_tree",
        message:"The exact action path was not found in the solver tree. Inner Game will need to rebuild this solve.",
        expectedPath:expected,
        availableHeroNodes:candidates.slice(0,12).map(n=>n.node)
      });
    }
    const node=await pokeraiPost("/v1/gto/solver/node",{node:target.token,hole_cards:job.heroHand});
    const strategy=node.strategy||[];
    let evs=null;
    try{
      const evResult=await pokeraiPost("/v1/gto/evs",{solve:job.solve,node_id:target.node,hand:job.heroHand});
      const values=Array.isArray(evResult.evs)?evResult.evs:(evResult.evs?.[job.heroHand]||null);
      evs=values?{actions:evResult.actions||[],values}:null;
    }catch{}
    const evChoice=evs?evBest(evs.actions,evs.values):{action:"",ev:null};
    const bestAction=evChoice.action||strategyBest(strategy);
    const bestFrequency=actionFreq(strategy,bestAction);
    const solution={
      provider:"pokerai",
      street:job.decisionStreet,
      node:target.node,
      strategy,
      evs,
      bestAction,
      bestFrequency,
      bestEv:evChoice.ev,
      solveSeconds:tree.solve_seconds||null,
      assumptions:job.assumptions||[]
    };
    solution.explanation=await explainSolution({spot:job.spot,strategy,evs,bestAction,provider:"pokerai",assumptions:solution.assumptions});
    try{ await pokeraiPost("/v1/gto/solver/release",{solve:job.solve}); }catch{}
    console.log(JSON.stringify({event:"solver_completed",ms:Date.now()-startedAt,street:job.decisionStreet,node:target.node,bestAction}));
    return res.json({status:"solved",solution});
  }catch(error){
    console.error(JSON.stringify({event:"solver_poll_failed",ms:Date.now()-startedAt,code:error?.code,error:String(error?.message||error)}));
    const status=error?.status===429?202:(error?.status&&error.status<500?error.status:500);
    if(status===202)return res.status(202).json({status:"pending",message:String(error?.message||"Solver busy")});
    return res.status(status).json({error:error?.code||"solver_failed",message:String(error?.message||"Solver failed")});
  }
});

const port = Number(process.env.PORT || 3000);
app.listen(port,()=>console.log(`Inner Game hand analysis API listening on ${port}`));
