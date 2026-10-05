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
  actionHistory:z.array(solverActionSchema),
  missingFields:z.array(z.string()),
  extractionNotes:z.array(z.string())
});

const solverInspectJsonSchema = {
  type:"object",
  additionalProperties:false,
  required:["confidence","game","format","tableSize","heroPosition","villainPosition","heroRole","heroCards","board","decisionStreet","effectiveStackBb","potAtDecisionBb","heroStackBb","villainStackBb","flopStartPotBb","flopStartEffectiveStackBb","actionHistoryComplete","actionHistory","missingFields","extractionNotes"],
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
  const segments=[];
  const board=(spot.board||[]).map(normalizeCard);
  for(const street of ["flop","turn","river"]){
    if(street==="turn" && board[3]) segments.push({type:"CARD",card:board[3]});
    if(street==="river" && board[4]) segments.push({type:"CARD",card:board[4]});
    for(const action of (spot.actionHistory||[]).filter(a=>a.street===street)){
      const segment=actionSegment(action);
      if(segment) segments.push(segment);
    }
    if(street===spot.decisionStreet) break;
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
  const bet_sizes={},raise_sizes={};
  for(const street of ["flop","turn","river"]){
    const bets=(spot.actionHistory||[]).filter(a=>a.street===street&&a.action==="bet"&&a.sizePctPot>0).map(a=>Math.round(a.sizePctPot));
    const raises=(spot.actionHistory||[]).filter(a=>a.street===street&&["raise","allin"].includes(a.action)&&a.sizePctPot>0).map(a=>Math.round(a.sizePctPot));
    bet_sizes[street]=[...new Set([33,67,100,...bets])].filter(x=>x>=5&&x<=300).slice(0,5);
    raise_sizes[street]=[...new Set([50,100,...raises])].filter(x=>x>=10&&x<=400).slice(0,5);
  }
  return {bet_sizes,raise_sizes};
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
    {id:"deepsolver",configured:Boolean(process.env.DEEPSOLVER_API_TOKEN),formats:["NLH postflop"],stackDepth:"custom"}
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
    const prompt=[
      "Prepare this saved poker screenshot for a post-hand GTO solver.",
      "This is review/study after the hand, never real-time assistance.",
      "The screenshot is the source of truth. Existing saved-hand metadata is only a hint.",
      "We may solve ONLY if every action from blind posting/preflop through the exact screenshot decision is known.",
      "Never invent an action that is not visible or logically forced by visible information.",
      "If any action, position, card, stack, or required sizing is missing or ambiguous, actionHistoryComplete MUST be false and missingFields must say exactly what the user needs to fix.",
      "actionHistory contains actions BEFORE Hero's screenshot decision only. Do not add Hero's not-yet-taken decision.",
      "Include preflop folds when visible/required to reconstruct the spot.",
      "For bet/raise amountBb use the absolute wager/raise-to amount in big blinds on that street when it can be determined. For call, amountBb may be the matched wager; for checks/folds use 0.",
      "For bet/raise sizePctPot use the standard percentage-of-pot sizing when it can be determined; otherwise 0 and add that sizing to missingFields.",
      "flopStartPotBb is the pot entering the flop before flop betting. flopStartEffectiveStackBb is the effective stack behind entering the flop. Calculate them only when the visible complete action line makes that arithmetic reliable; otherwise 0 and mark missing.",
      "heroStackBb/villainStackBb are stacks behind at the screenshot decision when visible.",
      "Use canonical positions SB, BB, UTG, MP, CO, BTN for 6-max. For other table sizes, use the visible conventional labels.",
      "heroRole is OOP or IP versus the remaining villain postflop.",
      "Use compact cards such as As, Qh, 7d, Tc.",
      `Existing saved hand hint: ${JSON.stringify(hand)}`
    ].join("\n");
    const response=await client.responses.create({
      model:MODEL,
      input:[{role:"user",content:[
        {type:"input_text",text:prompt},
        {type:"input_image",image_url:imageDataUrl,detail:"high"}
      ]}],
      text:{format:{type:"json_schema",name:"solver_spot_inspection",strict:true,schema:solverInspectJsonSchema}}
    });
    const spot=solverSpotSchema.parse(JSON.parse(response.output_text));
    spot.heroCards=validateCards(spot.heroCards).map(normalizeCard);
    spot.board=validateCards(spot.board).map(normalizeCard);
    spot.heroPosition=normalizePosition(spot.heroPosition);
    spot.villainPosition=normalizePosition(spot.villainPosition);
    spot.actionHistory=spot.actionHistory.map(a=>({...a,position:normalizePosition(a.position)}));
    spot.missingFields=solverReadiness(spot);
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
    const spot=solverSpotSchema.parse(req.body?.spot||{});
    spot.heroCards=(spot.heroCards||[]).map(normalizeCard);
    spot.board=(spot.board||[]).map(normalizeCard);
    spot.heroPosition=normalizePosition(spot.heroPosition);
    spot.villainPosition=normalizePosition(spot.villainPosition);
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
      raise_limit:3
    });
    const solve=schedule.solve;
    if(!solve)return res.status(502).json({error:"solver_schedule_failed",message:"The solver did not return a solve handle."});
    const assumptions=[
      `Exact postflop stack: ${spot.flopStartEffectiveStackBb} BB entering flop`,
      `Hero preflop range seeded from ${heroRangeInfo.version}`,
      `Villain preflop range seeded from ${villainRangeInfo.version}`,
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
      return res.status(422).json({
        error:"action_path_not_in_tree",
        message:"The exact action path was not found in the solver tree. Review the action sizes before solving.",
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
