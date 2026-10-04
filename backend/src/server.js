import express from "express";
import cors from "cors";
import OpenAI from "openai";
import { z } from "zod";

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "18mb" }));

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";

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

function validateCards(cards){
  const rx=/^(10|[2-9TJQKA])[shdc♠♥♦♣]?$/i;
  return cards.filter(c=>rx.test(String(c).trim()));
}

app.get("/health", (_req,res)=>res.json({ok:true,model:MODEL}));

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
      text:{
        format:{
          type:"json_schema",
          name:"poker_hand_capture",
          strict:true,
          schema
        }
      }
    });

    const parsed = handSchema.parse(JSON.parse(response.output_text));
    parsed.heroCards = validateCards(parsed.heroCards);
    parsed.board = validateCards(parsed.board);
    console.log(JSON.stringify({event:"hand_analyzed",ms:Date.now()-startedAt,model:MODEL,confidence:parsed.confidence,isPokerHand:parsed.isPokerHand}));
    return res.json(parsed);
  }catch(error){
    console.error(JSON.stringify({event:"hand_analysis_failed",ms:Date.now()-startedAt,model:MODEL,error:String(error?.message||error)}));
    return res.status(500).json({error:"Hand analysis failed"});
  }
});

const port = Number(process.env.PORT || 3000);
app.listen(port,()=>console.log(`Inner Game hand analysis API listening on ${port}`));
