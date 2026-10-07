import express from "express";
import cors from "cors";
import OpenAI from "openai";
import { z } from "zod";
import { normalizePosition, reconstructSolverMath, roundBb } from "./solver-math.js";
import { createInspectionJobs } from "./inspection-jobs.js";
import { createBackgroundHandJobs } from "./background-hand-jobs.js";
import { readEvs, foldEv, normalizeDecisionEvs, bestEvAction, foldReferenceNodes } from "./solver-ev.js";

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "18mb" }));

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const SOLVER_INSPECT_MODEL = process.env.SOLVER_INSPECT_MODEL || "gpt-5.6-sol";
const SOLVER_INSPECT_REASONING = process.env.SOLVER_INSPECT_REASONING || "medium";
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
  action:z.enum(["small_blind","big_blind","fold","check","call","bet","donk_bet","raise","allin","unknown"]),
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
  heroDisplayedStackBb:z.number(),
  villainDisplayedStackBb:z.number(),
  displayedStacksTiming:z.enum(["before_decision","after_decision_before_pot_award","after_pot_award","unknown"]),
  finalPotBb:z.number(),
  streetStartPotsBb:z.object({
    preflop:z.number(),
    flop:z.number(),
    turn:z.number(),
    river:z.number()
  }),
  actionHistory:z.array(solverActionSchema),
  actionHistoryAfterDecision:z.array(solverActionSchema).default([]),
  missingFields:z.array(z.string()),
  extractionNotes:z.array(z.string())
});

const solverActionInputSchema = solverActionSchema.extend({
  amountBb:z.coerce.number(),
  sizePctPot:z.coerce.number()
});
const solverSpotInputSchema = solverSpotSchema.extend({
  confidence:z.coerce.number(),
  tableSize:z.coerce.number().int(),
  effectiveStackBb:z.coerce.number(),
  potAtDecisionBb:z.coerce.number(),
  heroStackBb:z.coerce.number(),
  villainStackBb:z.coerce.number(),
  flopStartPotBb:z.coerce.number(),
  flopStartEffectiveStackBb:z.coerce.number(),
  observedHeroAmountBb:z.coerce.number(),
  heroDisplayedStackBb:z.coerce.number(),
  villainDisplayedStackBb:z.coerce.number(),
  finalPotBb:z.coerce.number(),
  streetStartPotsBb:z.object({
    preflop:z.coerce.number(),
    flop:z.coerce.number(),
    turn:z.coerce.number(),
    river:z.coerce.number()
  }),
  actionHistory:z.array(solverActionInputSchema),
  actionHistoryAfterDecision:z.array(solverActionInputSchema).default([])
});

const solverInspectJsonSchema = {
  type:"object",
  additionalProperties:false,
  required:["confidence","game","format","tableSize","heroPosition","villainPosition","heroRole","heroCards","board","decisionStreet","effectiveStackBb","potAtDecisionBb","heroStackBb","villainStackBb","flopStartPotBb","flopStartEffectiveStackBb","actionHistoryComplete","observedHeroAction","observedHeroAmountBb","heroDisplayedStackBb","villainDisplayedStackBb","displayedStacksTiming","finalPotBb","streetStartPotsBb","actionHistory","actionHistoryAfterDecision","missingFields","extractionNotes"],
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
    heroDisplayedStackBb:{type:"number"},
    villainDisplayedStackBb:{type:"number"},
    displayedStacksTiming:{type:"string",enum:["before_decision","after_decision_before_pot_award","after_pot_award","unknown"]},
    finalPotBb:{type:"number"},
    streetStartPotsBb:{
      type:"object",
      additionalProperties:false,
      required:["preflop","flop","turn","river"],
      properties:{
        preflop:{type:"number"},
        flop:{type:"number"},
        turn:{type:"number"},
        river:{type:"number"}
      }
    },
    actionHistory:{
      type:"array",
      items:{
        type:"object",
        additionalProperties:false,
        required:["street","position","action","amountBb","sizePctPot"],
        properties:{
          street:{type:"string",enum:["preflop","flop","turn","river"]},
          position:{type:"string"},
          action:{type:"string",enum:["small_blind","big_blind","fold","check","call","bet","donk_bet","raise","allin","unknown"]},
          amountBb:{type:"number"},
          sizePctPot:{type:"number"}
        }
      }
    },
    missingFields:{type:"array",items:{type:"string"}},
    extractionNotes:{type:"array",items:{type:"string"}}
  }
};

solverInspectJsonSchema.properties.actionHistoryAfterDecision = solverInspectJsonSchema.properties.actionHistory;

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
  const text=String(card).replace("10","T").replace("♠","s").replace("♥","h").replace("♦","d").replace("♣","c").trim();
  const match=text.match(/^([2-9TJQKA])([shdc])$/i);
  return match?match[1].toUpperCase()+match[2].toLowerCase():text;
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
function solverDebugId(){ return "sv_"+Date.now().toString(36)+"_"+Math.random().toString(36).slice(2,8); }
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
    signal:AbortSignal.timeout(25000),
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
function preflopVersion(stackBb){
  return Number(stackBb)>0 && Number(stackBb)<=60 ? "6max_RC_40bb" : "6max_RC_100bb_200NL";
}
function expandShortHandedPreflopForSixMax(spot){
  const n=Number(spot.tableSize)||6;
  if(n>=6||n<3)return spot;
  const missingLeading=["UTG","MP","CO"].slice(0,6-n);
  const rows=Array.isArray(spot.actionHistory)?spot.actionHistory:[];
  const pre=rows.filter(a=>a.street==="preflop");
  const rest=rows.filter(a=>a.street!=="preflop");
  const posts=pre.filter(a=>["small_blind","big_blind"].includes(a.action));
  const voluntary=pre.filter(a=>!["small_blind","big_blind"].includes(a.action));
  const seen=new Set(voluntary.map(a=>normalizePosition(a.position)));
  const synth=missingLeading.filter(p=>!seen.has(p)).map(position=>({
    street:"preflop",position,action:"fold",amountBb:0,sizePctPot:0,synthetic:true
  }));
  if(synth.length){
    spot.actionHistory=[...posts,...synth,...voluntary,...rest];
    spot.extractionNotes=[...(spot.extractionNotes||[]),`Short-handed ${n}-max mapped to 6-max preflop by treating empty early seats as folds: ${synth.map(x=>x.position).join(", ")}.`];
  }
  return spot;
}
function actionKey(action){
  const a=String(action||"").toLowerCase();
  if(a==="allin") return "raise";
  if(["raise","bet"].includes(a)) return "raise";
  if(a==="call") return "call";
  if(a==="fold") return "fold";
  return a;
}
function pokeraiPreflopActions(actions=[]){
  const invested={};
  const out=[];
  for(const source of actions||[]){
    const position=normalizePosition(source.position);
    const rawAction=String(source.action||"").toLowerCase();
    const normalizedAction=(rawAction==="bet"||rawAction==="donk_bet")?"raise":rawAction;
    const actionMap={
      small_blind:"small blind",
      big_blind:"big blind",
      fold:"fold",
      call:"call",
      raise:"raise",
      allin:"raise"
    };
    const mapped=actionMap[normalizedAction];
    if(!mapped||!position)continue;
    const row={position,action:mapped};
    if(mapped!=="fold"){
      const before=Number(invested[position]||0);
      const highest=Math.max(0,...Object.values(invested).map(Number));
      const rawAmount=Math.max(0,Number(source.amountBb)||0);
      let added=0;
      if(normalizedAction==="call"){
        // Internal hand history stores calls as the additional chips called.
        // A zero amount is reconstructed from the outstanding wager.
        added=rawAmount>0?rawAmount:Math.max(0,highest-before);
      }else{
        // Internal raises are stored as raise-to totals. PokerAI expects the
        // incremental amount newly invested by this action.
        added=Math.max(0,rawAmount-before);
      }
      row.amount=roundBb(added);
      invested[position]=roundBb(before+added);
    }
    if(normalizedAction==="allin")row.allin=true;
    out.push(row);
  }
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
  if(lastIndex<0) throw Object.assign(new Error(`Missing final preflop action for ${position}`),{code:"missing_preflop_range_action",status:422});
  const chosen=pre[lastIndex];
  if(!["fold","call","raise","allin"].includes(chosen.action)) throw Object.assign(new Error(`Unsupported preflop action for ${position}`),{code:"unsupported_preflop_range_action",status:422});
  const prior=pokeraiPreflopActions(pre.slice(0,lastIndex));
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
  if(rows.some(a=>["bet","donk_bet","raise","allin"].includes(a.action)&&!(Number(a.amountBb)>0)))issues.push("Bet and raise amounts must be greater than zero");
  const hero=normalizePosition(spot.heroPosition), villain=normalizePosition(spot.villainPosition);
  const oop=positionOrder(hero)<positionOrder(villain)?hero:villain;
  for(const street of ["flop","turn","river"]){
    const actions=rows.filter(a=>a.street===street);
    if(!actions.length){
      if(street===spot.decisionStreet && hero!==oop)issues.push(`${street}: missing opponent action before Hero's decision`);
      continue;
    }
    if(actions[0].position!==oop)issues.push(`${street}: the out-of-position player must act first`);
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
      }else if(a.action==="bet"||a.action==="donk_bet"){
        if(outstanding){issues.push(`${street}: bet appears while a bet is already outstanding`);break;}
        outstanding=true;checks=0;
      }else if(a.action==="allin"){
        // A shove can open the betting as well as raise an existing wager.
        outstanding=true;checks=0;
      }else if(a.action==="raise"){
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
    if(street===spot.decisionStreet){
      if(terminal)issues.push(`${street}: the decision path already ends the betting round`);
      else if(lastActor===hero)issues.push(`${street}: the next decision belongs to the opponent`);
    }
  }
  return [...new Set(issues)];
}

function normalizeSolverSpot(spot){
  spot.heroCards=validateCards(spot.heroCards).map(normalizeCard);
  spot.board=validateCards(spot.board).map(normalizeCard);
  spot.heroPosition=normalizePosition(spot.heroPosition);
  spot.villainPosition=normalizePosition(spot.villainPosition);
  if(spot.heroPosition && spot.villainPosition && spot.heroPosition!==spot.villainPosition){
    spot.heroRole=positionOrder(spot.heroPosition)<positionOrder(spot.villainPosition)?"OOP":"IP";
  }
  spot.actionHistory=(spot.actionHistory||[]).map(a=>({...a,position:normalizePosition(a.position),action:a.action==="donk_bet"?"bet":a.action}));
  spot.actionHistoryAfterDecision=(spot.actionHistoryAfterDecision||[]).map(a=>({...a,position:normalizePosition(a.position),action:a.action==="donk_bet"?"bet":a.action}));
  ensureBlindPosts(spot);
  stripObservedHeroDecision(spot);
  return spot;
}
async function extractSolverSpot(imageDataUrl,hand={},repairContext=null){
  const prompt=[
    "Extract a solver-ready poker hand from this screenshot. This is post-hand study only.",
    "Use the IMAGE as the source of truth. Existing saved-hand metadata may be wrong.",
    "Your job is VISUAL TRANSCRIPTION first; deterministic backend code will do the poker arithmetic afterward.",
    "CRITICAL HERO RULE: Hero is the user's own seat/hole cards, normally the bottom-center seat in a replayer. Never use an opponent's showdown cards or winner panel as Hero's cards.",
    "Read each street column top-to-bottom. Attribute every action to the player whose avatar/name bubble or colored Hero box owns it.",
    "Yellow/colored anonymous action boxes in common replay UIs often belong to Hero; named white bubbles belong to that named seat. Use geometry and column order, not guesswork.",
    "actionHistory must contain every action from SB/BB posting through immediately BEFORE Hero's decision. Put Hero's actual already-visible decision separately in observedHeroAction/observedHeroAmountBb and EXCLUDE it from actionHistory.",
    "actionHistoryAfterDecision must transcribe all visible betting actions AFTER Hero's observed decision, including the opponent's response and later streets. Never include these in actionHistory: they are used only to reconcile final pots and displayed stacks, not to select the solver node. Use [] when none are visible.",
    "Always include blind posts first: SB small_blind 0.5 BB then BB big_blind 1 BB when standard blinds are visible/inferable from the hand header.",
    "For preflop raises and postflop raises, amountBb is the raise-to total on that street. For calls, amountBb is the additional amount called. For bets/all-ins without a prior bet, amountBb is the wager amount.",
    "streetStartPotsBb must TRANSCRIBE the pot shown at the start/header of each street. Use 0 when not visible. Do not calculate these yourself.",
    "heroDisplayedStackBb and villainDisplayedStackBb must transcribe the stack numbers printed at those seats, converted to BB only when blind size is visible. Use 0 if not visible.",
    "displayedStacksTiming: use after_decision_before_pot_award only for completed-hand/replayer screenshots where stacks reflect all shown betting actions but the winning pot has not yet been added to the winner; before_decision for a live/review decision display before Hero acts; after_pot_award only if the pot is clearly already credited; otherwise unknown.",
    "finalPotBb is the final pot/win amount shown by the replayer, in BB, or 0 if unavailable.",
    "Do not trust seat stacks to infer starting stacks. Do not calculate effectiveStackBb, potAtDecisionBb, flopStartEffectiveStackBb, or sizePctPot: set uncertain derived values to 0. The backend reconstructs them.",
    "Set actionHistoryComplete=false whenever a visible action, actor, amount, position, card, or street order is ambiguous.",
    "Use canonical positions SB, BB, UTG, MP, CO, BTN for 6-max. Identify the dealer/button marker before assigning positions.",
    "tableSize counts players dealt into this hand. Exclude seats marked Sitting Out or empty; do not use the table's seat capacity. In a four-player hand use CO, BTN, SB, BB for the active positions.",
    "Use compact cards like Kc Qd 4c 5c 9c 6h Qh.",
    repairContext ? `Previous extraction/validation feedback: ${JSON.stringify(repairContext)}. Re-read the IMAGE and fix the visual transcription.` : "",
    `Existing saved-hand hint (weak hint only): ${JSON.stringify(hand)}`
  ].filter(Boolean).join("\n");
  const response=await client.responses.create({
    model:SOLVER_INSPECT_MODEL,
    reasoning:{effort:SOLVER_INSPECT_REASONING},
    input:[{role:"user",content:[
      {type:"input_text",text:prompt},
      {type:"input_image",image_url:imageDataUrl,detail:"high"}
    ]}],
    text:{format:{type:"json_schema",name:"solver_spot_inspection",strict:true,schema:solverInspectJsonSchema}}
  },{timeout:240000,maxRetries:0});
  let decoded;
  try{
    if(!response.output_text||!String(response.output_text).trim())throw new Error("empty model output");
    decoded=JSON.parse(response.output_text);
  }catch(error){
    throw Object.assign(new Error(`Solver extraction returned invalid JSON: ${String(error?.message||error)}`),{code:"solver_extract_invalid_json",status:502});
  }
  const parsed=solverSpotSchema.safeParse(decoded);
  if(!parsed.success){
    throw Object.assign(new Error("Solver extraction returned an invalid hand shape."),{
      code:"solver_extract_invalid_shape",status:502,
      validation:parsed.error.issues.map(issue=>({path:issue.path.join("."),message:issue.message}))
    });
  }
  const raw=parsed.data;
  const rawSpot=JSON.parse(JSON.stringify(raw));
  const spot=normalizeSolverSpot(raw);
  const reconstructed=reconstructSolverMath(spot);
  return {
    spot:reconstructed.spot,
    debug:{
      model:SOLVER_INSPECT_MODEL,
      rawSpot,
      reconstruction:{
        issues:reconstructed.issues,
        streetSnapshots:reconstructed.streetSnapshots,
        finalPotFromActions:reconstructed.finalPotFromActions,
        uncalledReturnBb:reconstructed.uncalledReturnBb,
        heroStartBb:reconstructed.heroStartBb,
        villainStartBb:reconstructed.villainStartBb
      }
    }
  };
}
function preflopRangeReadinessIssues(spot){
  if(spot.decisionStreet==="preflop")return [];
  const rows=(spot.actionHistory||[]).filter(a=>a.street==="preflop");
  const issues=[];
  for(const position of [spot.heroPosition,spot.villainPosition].map(normalizePosition).filter(Boolean)){
    const actions=rows.filter(a=>normalizePosition(a.position)===position&&!["small_blind","big_blind"].includes(a.action));
    const chosen=actions.at(-1);
    if(!chosen){
      issues.push(`Missing final preflop action for ${position}`);
      continue;
    }
    if(!["call","raise","allin"].includes(chosen.action)){
      issues.push(`Unsupported final preflop action for ${position}: ${chosen.action}`);
    }
  }
  return issues;
}
function solverReadiness(spot){
  const missing=[];
  if(spot.game!=="NLH") missing.push("No-limit Hold’em");
  if(!Number.isFinite(spot.tableSize)||spot.tableSize<2) missing.push("Table size");
  if(!spot.heroPosition) missing.push("Hero position");
  if(spot.decisionStreet==="unknown") missing.push("Decision street");
  if((spot.heroCards||[]).length!==2) missing.push("Hero cards");
  const cards=[...(spot.heroCards||[]),...(spot.board||[])].map(card=>normalizeCard(card).toLowerCase());
  if(new Set(cards).size!==cards.length)missing.push("Duplicate cards in Hero's hand or board");
  if(spot.heroPosition && spot.heroPosition===spot.villainPosition)missing.push("Hero and opponent must occupy different positions");
  const boardNeed=spot.decisionStreet==="flop"?3:spot.decisionStreet==="turn"?4:spot.decisionStreet==="river"?5:0;
  if(boardNeed && (spot.board||[]).length<boardNeed) missing.push("Board");
  if(!spot.actionHistoryComplete) missing.push("Complete action history from preflop to this decision");
  missing.push(...solverActionHistoryIssues(spot));
  missing.push(...preflopRangeReadinessIssues(spot));
  if(spot.decisionStreet!=="preflop"){
    if(!spot.villainPosition) missing.push("Villain position");
    if(!(spot.flopStartPotBb>0)) missing.push("Pot entering flop");
    if(!(spot.flopStartEffectiveStackBb>0)) missing.push("Effective stack entering flop");
  }
  return [...new Set([...(spot.missingFields||[]),...missing])];
}
function actionSegment(action,facingBet=false){
  if(action.action==="check")return {type:"CHECK"};
  if(action.action==="call")return {type:"CALL"};
  if(action.action==="bet"||action.action==="donk_bet")return {type:"BET",amount:Number(action.amountBb)||0};
  if(action.action==="raise")return {type:"RAISE",amount:Number(action.amountBb)||0};
  if(action.action==="allin")return {type:facingBet?"RAISE":"BET",amount:Number(action.amountBb)||0};
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
    let facingBet=false;
    for(const action of (spot.actionHistory||[]).filter(a=>a.street===street)){
      const segment=actionSegment(action,facingBet);
      if(segment)segments.push(segment);
      if(["bet","donk_bet","raise","allin"].includes(action.action))facingBet=true;
      if(["call","fold"].includes(action.action))facingBet=false;
    }
    if(street===spot.decisionStreet)break;
    if(street==="flop" && board[3])segments.push({type:"CARD",card:board[3]});
    if(street==="turn" && board[4])segments.push({type:"CARD",card:board[4]});
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
    const bets=[],raises=[];
    let facingBet=false;
    for(const action of (spot.actionHistory||[]).filter(a=>a.street===street)){
      if(action.sizePctPot>0){
        if(action.action==="bet"||action.action==="donk_bet"||(action.action==="allin"&&!facingBet))bets.push(Math.round(action.sizePctPot));
        if(action.action==="raise"||(action.action==="allin"&&facingBet))raises.push(Math.round(action.sizePctPot));
      }
      if(["bet","donk_bet","raise","allin"].includes(action.action))facingBet=true;
      if(["call","fold"].includes(action.action))facingBet=false;
    }
    // Put the replay's observed size first so any provider-side size budget
    // preserves the action we need to query before adding study alternatives.
    const baseBets=[...bets,33,67,100];
    bet_sizes[street]=[...new Set(baseBets)].filter(x=>x>=5&&x<=300).slice(0,6);
    // A lead from OOP on a later street after calling the previous street is a
    // donk in Pokerai's tree. Include the observed bet sizings here as well so
    // exact hand-history lines such as a 100% river donk exist in the tree.
    donk_sizes[street]=[...new Set(baseBets)].filter(x=>x>=5&&x<=300).slice(0,6);
    raise_sizes[street]=[...new Set([...raises,50,100])].filter(x=>x>=10&&x<=400).slice(0,6);
  }
  return {bet_sizes,raise_sizes,donk_sizes};
}
async function explainSolution({spot,strategy,evs,bestAction,provider,assumptions}){
  const frequentAction=strategyBest(strategy);
  if(evs?.actions?.length && frequentAction && bestAction && actionFreq(strategy,bestAction)+1e-9<actionFreq(strategy,frequentAction)){
    return {
      summary:`The solver uses ${solverActionText(frequentAction)} most often (${solverFrequencyText(actionFreq(strategy,frequentAction))}). ${solverActionText(bestAction)} has the highest reported EV.`,
      details:"The strategy mix and EV ranking differ at this node. These are the provider's estimates; the highest-EV action is not necessarily the most frequent action.",
      facts:[]
    };
  }
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
          "If evs.reference is decision, EV is measured from this decision: folding is zero and prior chips invested are sunk costs. Checking is not automatically zero. If reference is provider, its absolute zero is unverified: explain only EV differences, never claim a negative raw value means this decision loses money. Frequencies refer to this exact hand, not other hands in a range. Do not explain disagreements between frequencies and EVs with invented reasons.",
          JSON.stringify({spot,strategy,evs,bestAction,provider,assumptions})
        ].join("\n")}]
      }],
      text:{format:{type:"json_schema",name:"solver_explanation",strict:true,schema:explanationSchema}}
    },{timeout:12000,maxRetries:0});
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
  const item=[...strategy].sort((a,b)=>(Number(b.frequency)||0)-(Number(a.frequency)||0))[0];
  if(!item)return "";
  const action=String(item.action||"").trim();
  return /^(bet|raise)$/i.test(action)&&Number(item.amount_bb)>0?`${action} ${Number(item.amount_bb)}`:action;
}
function solverActionText(action){
  const match=String(action).match(/^(BET|RAISE)\s+([\d.]+)$/i);
  return match?`${match[1].toUpperCase()} ${Number(match[2]).toFixed(1)} BB`:String(action).toUpperCase();
}
function solverFrequencyText(frequency){
  const percent=Math.max(0,Math.min(1,Number(frequency)||0))*100;
  return percent>0&&percent<.01?"<0.01%":`${Number(percent.toFixed(percent<1?2:1))}%`;
}
function evBest(actions=[],values=[]){
  return bestEvAction(actions,values);
}
function actionFreq(strategy=[],action=""){
  const normalized=String(action).toLowerCase();
  const [kind,amount]=normalized.split(/\s+/);
  const item=strategy.find(x=>String(x.action||"").toLowerCase()===normalized ||
    String(x.action||"").toLowerCase()===kind && Number.isFinite(Number(amount)) && Math.abs(Number(x.amount_bb)-Number(amount))<.001);
  return item?Number(item.frequency)||0:0;
}

app.get("/health", (_req,res)=>res.json({ok:true,model:MODEL,solverInspectModel:SOLVER_INSPECT_MODEL,solver:{pokeraiConfigured:Boolean(POKERAI_KEY)}}));
app.get("/solver/status", (_req,res)=>res.json({
  configured:Boolean(POKERAI_KEY),
  providers:[
    {id:"pokerai",configured:Boolean(POKERAI_KEY),formats:["6max NLH"],stackDepth:"custom postflop; 40bb/100bb standard preflop range seeds"},
    {id:"deepsolver",configured:Boolean(process.env.DEEPSOLVER_API_TOKEN),implemented:false,formats:["NLH postflop"],stackDepth:"custom"}
  ]
}));

async function handleHandAnalysis(req,res){
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
    },{timeout:120000,maxRetries:0});

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
}
app.post("/analyze-hand",handleHandAnalysis);

const inspectionJobs=createInspectionJobs();
async function inspectSolverHand(imageDataUrl,hand,requestId){
  const startedAt=Date.now();
  try{
    const first=await extractSolverSpot(imageDataUrl,hand);
    const spot=first.spot;
    spot.missingFields=solverReadiness({...spot,missingFields:spot.missingFields||[]});
    const debug={
      requestId,
      stage:"inspect_complete",
      model:SOLVER_INSPECT_MODEL,
      durationMs:Date.now()-startedAt,
      firstPass:first.debug,
      repairPass:null,
      repairStrategy:"manual_retry_only",
      chosen:{
        spot,
        historyIssues:solverActionHistoryIssues(spot),
        missingFields:spot.missingFields
      }
    };
    console.log(JSON.stringify({event:"solver_spot_inspected",requestId,ms:Date.now()-startedAt,model:SOLVER_INSPECT_MODEL,ready:spot.missingFields.length===0,street:spot.decisionStreet,hero:spot.heroPosition,heroCards:spot.heroCards,flopStack:spot.flopStartEffectiveStackBb,potAtDecision:spot.potAtDecisionBb,missing:spot.missingFields.length}));
    return {spot,ready:spot.missingFields.length===0,debug};
  }catch(error){
    console.error(JSON.stringify({event:"solver_spot_inspect_failed",requestId,ms:Date.now()-startedAt,error:String(error?.message||error)}));
    throw error;
  }
}
function sendInspectionError(res,error,requestId){
  const status=Number(error?.status)||500;
  return res.status(status).json({error:error?.code||"solver_inspect_failed",message:String(error?.message||error),validation:error?.validation||null,debug:{requestId,stage:"inspect_exception"}});
}
app.post("/solver/inspect", async (req,res)=>{
  const requestId=solverDebugId();
  try{
    const {imageDataUrl,hand={}}=req.body||{};
    if(typeof imageDataUrl!=="string"||!imageDataUrl.startsWith("data:image/"))return res.status(400).json({error:"imageDataUrl is required",debug:{requestId,stage:"validate_input"}});
    if(imageDataUrl.length>16_000_000)return res.status(413).json({error:"Image too large"});
    if(req.body.async===true){
      const inspectionId=inspectionJobs.start(()=>inspectSolverHand(imageDataUrl,hand,requestId));
      return res.status(202).json({status:"pending",inspectionId,debug:{requestId,stage:"inspection_started"}});
    }
    // Existing installed clients can continue using the synchronous response.
    return res.json(await inspectSolverHand(imageDataUrl,hand,requestId));
  }catch(error){
    return sendInspectionError(res,error,requestId);
  }
});
app.post("/solver/inspect/poll", (req,res)=>{
  const inspectionId=req.body?.inspectionId;
  if(typeof inspectionId!=="string"||!inspectionId)return res.status(400).json({error:"missing_inspection",message:"Missing screenshot inspection job."});
  const job=inspectionJobs.get(inspectionId);
  if(!job)return res.status(410).json({error:"inspection_expired",message:"Screenshot inspection expired. Read the screenshot again."});
  if(job.status==="pending")return res.status(202).json({status:"pending",inspectionId});
  if(job.status==="failed")return sendInspectionError(res,job.error,inspectionId);
  return res.json(job.result);
});
async function handleSolverSolve(req,res){
  const startedAt=Date.now();
  const requestId=solverDebugId();
  let stage="start";
  try{
    if(!POKERAI_KEY)return res.status(503).json({error:"solver_not_configured",message:"Pokerai API key is not configured yet.",debug:{requestId,stage:"provider_config"}});
    stage="parse_spot";
    const parsedSpot=solverSpotInputSchema.safeParse(req.body?.spot||{});
    if(!parsedSpot.success){
      return res.status(422).json({
        error:"invalid_spot",
        message:"The saved hand data is incomplete or has invalid field types. Re-read the screenshot before solving.",
        validation:parsedSpot.error.issues.map(issue=>({path:issue.path.join("."),message:issue.message})),
        debug:{requestId,stage:"parse_spot",durationMs:Date.now()-startedAt}
      });
    }
    const spot=expandShortHandedPreflopForSixMax(normalizeSolverSpot(parsedSpot.data));
    reconstructSolverMath(spot);
    const missing=solverReadiness(spot);
    if(missing.length)return res.status(422).json({error:"incomplete_hand",message:"Complete the missing hand details before solving.",missingFields:missing,debug:{requestId,stage:"readiness",spot}});
    stage="provider_prepare";
    if(spot.tableSize<3||spot.tableSize>6)return res.status(422).json({error:"unsupported_format",message:"The current Pokerai adapter supports 3–6 handed NLH. Heads-up and larger tables require the fallback solver provider."});

    if(spot.decisionStreet==="preflop"){
      const actions=pokeraiPreflopActions((spot.actionHistory||[]).filter(a=>a.street==="preflop"));
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

    stage="derive_ranges";
    const [heroRangeInfo,villainRangeInfo]=await Promise.all([
      derivePlayerPreflopRange(spot,spot.heroPosition),
      derivePlayerPreflopRange(spot,spot.villainPosition)
    ]);
    const heroIsOop=spot.heroRole==="OOP" || (spot.heroRole==="unknown" && positionOrder(spot.heroPosition)<positionOrder(spot.villainPosition));
    const oopRange=heroIsOop?heroRangeInfo.range:villainRangeInfo.range;
    const ipRange=heroIsOop?villainRangeInfo.range:heroRangeInfo.range;
    const sizing=observedSizingConfig(spot);
    stage="schedule_solver";
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
      ...(spot.tableSize<6?[`${spot.tableSize}-handed preflop mapped to 6-max by treating empty earlier seats as folds.`]:[]),
      "Observed bet sizes included in the custom tree",
      "Post-hand study only"
    ];
    const debug={requestId,stage:"scheduled",durationMs:Date.now()-startedAt,spot,heroIsOop,sizing,expectedSegments:expectedPostflopSegments(spot),heroRangeVersion:heroRangeInfo.version,villainRangeVersion:villainRangeInfo.version};
    console.log(JSON.stringify({event:"solver_scheduled",requestId,ms:Date.now()-startedAt,street:spot.decisionStreet,solve:solve.slice(0,12)}));
    return res.status(202).json({
      status:"pending",
      debug,
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
        createdAt:Date.now(),
        debugRequestId:requestId
      }
    });
  }catch(error){
    console.error(JSON.stringify({event:"solver_schedule_failed",requestId,stage,ms:Date.now()-startedAt,code:error?.code,error:String(error?.message||error)}));
    return res.status(error?.status&&error.status<500?error.status:500).json({error:error?.code||"solver_failed",message:String(error?.message||"Solver failed"),debug:{requestId,stage,durationMs:Date.now()-startedAt,code:error?.code||"",status:error?.status||0,payload:error?.payload||null,stack:String(error?.stack||"")}});
  }
}

const nodeMatchWaits=new Map();
const pollInFlight=new Map(),pollCompleted=new Map();
app.post("/solver/solve",handleSolverSolve);
function legalSolverActions(spot){
  let facing=false;
  for(const action of (spot?.actionHistory||[]).filter(a=>a.street===spot.decisionStreet)){
    if(["bet","donk_bet","raise","allin"].includes(action.action))facing=true;
    if(["call","fold"].includes(action.action))facing=false;
  }
  return facing?["fold","call","raise","allin"]:["check","bet","allin"];
}
async function handleSolverPoll(req,res){
  const startedAt=Date.now();
  const requestId=solverDebugId();
  let stage="start";
  let claimedKey=null;
  try{
    if(!POKERAI_KEY)return res.status(503).json({error:"solver_not_configured",message:"Pokerai API key is not configured yet."});
    const job=req.body?.job||{};
    if(!job.solve)return res.status(400).json({error:"missing_job",message:"Missing solver job."});
    const key=job.solve+JSON.stringify(job.expectedSegments||[]);
    const now=Date.now();
    for(const [k,value] of pollCompleted)if(now-value.createdAt>300000)pollCompleted.delete(k);
    if(pollCompleted.has(key))return res.json(pollCompleted.get(key).result);
    if(pollInFlight.has(key))return res.status(202).json({status:"pending"});
    pollInFlight.set(key,now);claimedKey=key;
    stage="fetch_tree";
    const treeBody={solve:job.solve};
    if(job.decisionStreet==="turn"||job.decisionStreet==="river")treeBody.turn_card=job.turnCard;
    if(job.decisionStreet==="river")treeBody.river_card=job.riverCard;
    const tree=await pokeraiPost("/v1/gto/solver/tree",treeBody);
    if(["available","computing"].includes(tree.spot_status))return res.status(202).json({status:"pending",spotStatus:tree.spot_status,debug:{requestId,stage:"tree_pending",durationMs:Date.now()-startedAt,spotStatus:tree.spot_status}});
    if(tree.spot_status!=="queryable")return res.status(422).json({error:"solver_not_queryable",message:`Solver state: ${tree.spot_status||"unknown"}`});
    const expected=Array.isArray(job.expectedSegments)?job.expectedSegments:[];
    const candidates=(tree.nodes||[]).filter(n=>n.is_hero);
    const scored=candidates.map(n=>({node:n,score:nodeMatchScore(n.node,expected)})).filter(x=>Number.isFinite(x.score)).sort((a,b)=>a.score-b.score);
    const target=scored[0]?.node;
    stage="match_node";
    if(!target){
      // The provider can briefly expose a queryable tree before the requested
      // later-street runout is ready. Retry that tree before declaring failure.
      const key=job.solve+JSON.stringify(expected);
      const now=Date.now();
      for(const [k,value] of nodeMatchWaits)if(now-value>300000)nodeMatchWaits.delete(k);
      const firstMiss=nodeMatchWaits.get(key)??now;
      if(!nodeMatchWaits.has(key)){
        if(nodeMatchWaits.size>=500)nodeMatchWaits.delete(nodeMatchWaits.keys().next().value);
        nodeMatchWaits.set(key,now);
      }
      if(now-firstMiss<30000)return res.status(202).json({status:"pending",message:"Waiting for the requested action path and runout.",debug:{requestId,stage:"node_pending",candidateCount:candidates.length}});
      nodeMatchWaits.delete(key);
      try{await pokeraiPost("/v1/gto/solver/release",{solve:job.solve});}catch{}
      console.warn(JSON.stringify({
        event:"solver_node_match_failed",
        street:job.decisionStreet,
        expected,
        availableHeroNodes:candidates.slice(0,20).map(n=>n.node)
      }));
      return res.status(422).json({
        error:"action_path_not_in_tree",
        message:"The solver API did not return the observed action path. Your hand is saved; review the details or try solving again.",
        expectedPath:expected,
        availableHeroNodes:candidates.slice(0,12).map(n=>n.node),
        debug:{requestId,stage:"node_match_failed",expected,candidateCount:candidates.length,availableHeroNodes:candidates.slice(0,20).map(n=>n.node)}
      });
    }
    nodeMatchWaits.delete(job.solve+JSON.stringify(expected));
    stage="fetch_node";
    const node=await pokeraiPost("/v1/gto/solver/node",{node:target.token,hole_cards:job.heroHand});
    if(["available","computing"].includes(node.spot_status)||["available","computing"].includes(node.status))return res.status(202).json({status:"pending"});
    const strategy=node.strategy||[];
    const legal=legalSolverActions(job.spot);
    const canonicalHand=hand=>String(hand).replace(/\s/g,"").match(/.{2}/g)?.map(card=>normalizeCard(card)).sort().join("");
    if(!strategy.length||node.is_hero===false||node.node?.startsWith("root")&&node.node!==target.node||
      node.hole_cards&&canonicalHand(node.hole_cards)!==canonicalHand(job.heroHand)||
      strategy.some(item=>!legal.includes(String(item.action).toLowerCase().split(" ")[0]))){
      try{await pokeraiPost("/v1/gto/solver/release",{solve:job.solve});}catch{}
      return res.status(422).json({error:"invalid_solver_decision",message:"The solver returned actions that do not match Hero's decision. Review the hand before solving again."});
    }
    let evs=null;
    try{
      const evResult=await pokeraiPost("/v1/gto/evs",{solve:job.solve,node_id:target.node,hand:job.heroHand});
      if(evResult.node_id&&evResult.node_id!==target.node)throw new Error("EV response belongs to a different decision node");
      const rawEvs=readEvs(evResult,job.heroHand);
      if(rawEvs && rawEvs.actions.every(action=>legal.includes(String(action).toLowerCase().split(" ")[0]))){
        let baseline=rawEvs,baselineNode=target.node;
        if(foldEv(rawEvs)===null){
          const probe=foldReferenceNodes(tree.nodes||[],target)[0];
          if(probe){
            try{
              baseline=readEvs(await pokeraiPost("/v1/gto/evs",{solve:job.solve,node_id:probe.node,hand:job.heroHand}),job.heroHand);
              baselineNode=probe.node;
            }catch{baseline=null;}
          }
        }
        evs=normalizeDecisionEvs(rawEvs,baseline,baselineNode);
      }
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
      evReferenceVersion:1,
      solveSeconds:tree.solve_seconds||null,
      assumptions:job.assumptions||[]
    };
    solution.explanation=await explainSolution({spot:job.spot,strategy,evs,bestAction,provider:"pokerai",assumptions:solution.assumptions});
    const result={status:"solved",solution,debug:{requestId,stage:"complete",durationMs:Date.now()-startedAt,expected,targetNode:target.node,candidateCount:candidates.length,treeStatus:tree.spot_status}};
    if(pollCompleted.size>=500)pollCompleted.delete(pollCompleted.keys().next().value);
    pollCompleted.set(claimedKey,{createdAt:Date.now(),result});
    try{ await pokeraiPost("/v1/gto/solver/release",{solve:job.solve}); }catch{}
    console.log(JSON.stringify({event:"solver_completed",requestId,ms:Date.now()-startedAt,street:job.decisionStreet,node:target.node,bestAction}));
    return res.json(result);
  }catch(error){
    console.error(JSON.stringify({event:"solver_poll_failed",requestId,stage,ms:Date.now()-startedAt,code:error?.code,error:String(error?.message||error)}));
    const status=error?.status===429?202:(error?.status&&error.status<500?error.status:500);
    const debug={requestId,stage,durationMs:Date.now()-startedAt,code:error?.code||"",status:error?.status||0,payload:error?.payload||null,stack:String(error?.stack||"")};
    if(status===202)return res.status(202).json({status:"pending",message:String(error?.message||"Solver busy"),debug});
    return res.status(status).json({error:error?.code||"solver_failed",message:String(error?.message||"Solver failed"),debug});
  }finally{if(claimedKey)pollInFlight.delete(claimedKey);}
}
app.post("/solver/poll",handleSolverPoll);

async function invokeHandHandler(handler,body){
  const response={status:200,body:null};
  const res={status(code){response.status=code;return this;},json(data){response.body=data;return this;}};
  await handler({body},res);
  return response;
}
const backgroundHandJobs=createBackgroundHandJobs({
  analyze:body=>invokeHandHandler(handleHandAnalysis,body),
  reconstruct:body=>inspectSolverHand(body.imageDataUrl,body.hand||{},solverDebugId()),
  solve:body=>invokeHandHandler(handleSolverSolve,body),
  poll:body=>invokeHandHandler(handleSolverPoll,body)
});
app.post("/hand-jobs/start",(req,res)=>{
  try{
    const {kind,payload}=req.body||{};
    if(["analysis","reconstruction"].includes(kind)&&
      (typeof payload?.imageDataUrl!=="string"||!payload.imageDataUrl.startsWith("data:image/")||payload.imageDataUrl.length>16_000_000)){
      return res.status(400).json({error:"A screenshot image is required."});
    }
    const jobId=backgroundHandJobs.start(req.body||{});
    return res.status(202).json({status:"pending",jobId});
  }catch(error){return res.status(Number(error.status)||500).json({error:String(error.message||error)});}
});
app.post("/hand-jobs/poll",(req,res)=>{
  const job=backgroundHandJobs.get(req.body?.jobId);
  if(!job)return res.status(410).json({error:"hand_job_expired",message:"This hand job expired or processing was interrupted. Your screenshot is saved; tap Retry."});
  return res.status(job.status==="pending"?202:200).json(job);
});

let pipelineSmokeSpot=null;
let pipelineSmokeJob=null;
const PIPELINE_SMOKE_IMAGE="data:image/png;base64,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";

app.get("/__debug/solver-pipeline-v5/inspect",async (_req,res)=>{
  try{
    const first=await extractSolverSpot(PIPELINE_SMOKE_IMAGE,{title:"HH NL Hold'em $1 / $2",gameType:"cash",site:"test",stakes:"$1 / $2",heroPosition:"CO",heroCards:["Ah","Qh"],board:["Ad","Ts","8c","5h","Jd"],pot:"",actionSummary:""});
    pipelineSmokeSpot=first.spot;
    pipelineSmokeSpot.missingFields=solverReadiness({...pipelineSmokeSpot,missingFields:pipelineSmokeSpot.missingFields||[]});
    console.log(JSON.stringify({event:"pipeline_smoke_inspected",ready:pipelineSmokeSpot.missingFields.length===0,spot:pipelineSmokeSpot,debug:first.debug}));
    return res.json({ok:true,ready:pipelineSmokeSpot.missingFields.length===0,spot:pipelineSmokeSpot,debug:first.debug});
  }catch(error){
    console.error(JSON.stringify({event:"pipeline_smoke_inspect_failed",error:String(error?.stack||error)}));
    return res.status(Number(error?.status)||500).json({ok:false,error:String(error?.message||error)});
  }
});

app.get("/__debug/solver-pipeline-v5/solve",async (_req,res)=>{
  try{
    if(!pipelineSmokeSpot)return res.status(404).json({ok:false,error:"run inspect first"});
    const base=`http://127.0.0.1:${process.env.PORT||3000}`;
    const rr=await fetch(base+"/solver/solve",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({spot:pipelineSmokeSpot})});
    const json=await rr.json();
    if(rr.status===202&&json.job)pipelineSmokeJob=json.job;
    console.log(JSON.stringify({event:"pipeline_smoke_solve",status:rr.status,json}));
    return res.status(rr.status).json(json);
  }catch(error){
    return res.status(500).json({ok:false,error:String(error?.message||error)});
  }
});

app.get("/__debug/solver-pipeline-v5/poll",async (_req,res)=>{
  try{
    if(!pipelineSmokeJob)return res.status(404).json({ok:false,error:"run solve first"});
    const base=`http://127.0.0.1:${process.env.PORT||3000}`;
    const rr=await fetch(base+"/solver/poll",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({job:pipelineSmokeJob})});
    const json=await rr.json();
    if(rr.ok&&rr.status!==202)pipelineSmokeJob=null;
    console.log(JSON.stringify({event:"pipeline_smoke_poll",status:rr.status,json}));
    return res.status(rr.status).json(json);
  }catch(error){
    return res.status(500).json({ok:false,error:String(error?.message||error)});
  }
});

const port = Number(process.env.PORT || 3000);
if(process.env.NODE_ENV!=="test"){
  app.listen(port,()=>console.log(`Inner Game hand analysis API listening on ${port}`));
}

export {
  app,
  client,
  solverActionHistoryIssues,
  solverReadiness,
  solverInspectJsonSchema,
  expectedPostflopSegments,
  pokeraiPreflopActions,
  preflopRangeReadinessIssues,
  reconstructSolverMath,
  solverSpotInputSchema,
  legalSolverActions,
  actionFreq,
  strategyBest,
  explainSolution
};
